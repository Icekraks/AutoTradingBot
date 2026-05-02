import axios, { type AxiosInstance } from "axios";
import WebSocket from "ws";
import type { Asset, Candle, Order, Portfolio, Position } from "@trading-bot/shared";
import { OrderSide, OrderStatus, OrderType } from "@trading-bot/shared";
import type { IBroker, PlaceOrderParams } from "./broker.interface.js";
import type { AlpacaAccount, AlpacaBarsResponse, AlpacaLatestTrade, AlpacaOrderResponse, AlpacaPosition, AlpacaWSMessage } from "./alpaca.types.js";
import { config } from "../config.js";

export class AlpacaBroker implements IBroker {
  private http!: AxiosInstance;   // trading (account, orders, positions)
  private dataHttp!: AxiosInstance; // market data (bars, trades)
  private paper: boolean;
  private authHeaders!: Record<string, string>;

  constructor(paper = true) {
    this.paper = paper;
  }

  async connect(): Promise<void> {
    this.authHeaders = {
      "APCA-API-KEY-ID": config.alpaca.apiKey,
      "APCA-API-SECRET-KEY": config.alpaca.apiSecret,
      "Accept": "application/json",
    };
    this.rebuildHttp();
    this.dataHttp = axios.create({ baseURL: "https://data.alpaca.markets/v2", headers: this.authHeaders });

    const res = await this.http.get<AlpacaAccount>("/account");
    console.log(`[Alpaca] Connected — paper=${this.paper}, equity=$${Number(res.data.equity).toFixed(2)}`);
  }

  setBrokerPaper(_brokerName: string, paper: boolean): void {
    if (this.paper === paper) return;
    this.paper = paper;
    this.rebuildHttp();
    console.log(`[Alpaca] Switched to ${paper ? "paper" : "live"} mode`);
  }

  private rebuildHttp(): void {
    const baseURL = this.paper
      ? "https://paper-api.alpaca.markets/v2"
      : "https://api.alpaca.markets/v2";
    this.http = axios.create({ baseURL, headers: this.authHeaders });
  }

  async getCandles(
    asset: Asset,
    _quoteAsset: string,
    resolutionMinutes: number,
    count: number
  ): Promise<Candle[]> {
    // Go back far enough to cover `count` bars across trading sessions.
    // Do not specify feed= for historical bars — IEX is real-time only and causes
    // ECONNRESET on historical requests. Default (SIP) works for paper accounts.
    const start = new Date();
    start.setDate(start.getDate() - 30);

    const res = await withRetry(() =>
      this.dataHttp.get<AlpacaBarsResponse>(`/stocks/${asset}/bars`, {
        params: {
          timeframe: toAlpacaTimeframe(resolutionMinutes),
          limit: count,
          sort: "desc", // newest-first so limit gives us the most recent N bars
          start: start.toISOString(),
        },
      })
    );

    // Reverse to restore chronological order for the HMM and chart
    return (res.data.bars ?? []).reverse().map((b) => ({
      timestamp: new Date(b.t).getTime(),
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));
  }

  async getPrice(asset: Asset, _quoteAsset: string): Promise<number> {
    // Use SIP feed (same as bars) so prices are consistent. IEX only covers ~3-5%
    // of US equity volume and diverges from SIP bar close prices.
    const res = await this.dataHttp.get<AlpacaLatestTrade>(`/stocks/${asset}/trades/latest`);
    return res.data.trade.p;
  }

  async getPortfolio(): Promise<Portfolio> {
    const [accountRes, positionsRes] = await Promise.all([
      withRetry(() => this.http.get<AlpacaAccount>("/account")),
      withRetry(() => this.http.get<AlpacaPosition[]>("/positions")),
    ]);

    const cash = Number(accountRes.data.cash);
    const equity = Number(accountRes.data.equity);
    const quoteAsset = config.trading.quoteAsset;

    const positions: Position[] = positionsRes.data.map((p) => ({
      asset: p.symbol,
      pair: `${p.symbol}/${quoteAsset}` as `${string}/${string}`,
      side: OrderSide.Buy,
      quantity: Number(p.qty),
      entryPrice: Number(p.avg_entry_price),
      currentPrice: Number(p.current_price),
      stopLoss: 0,
      takeProfit: 0,
      unrealisedPnl: Number(p.unrealized_pl),
      unrealisedPnlPct: Number(p.unrealized_plpc) * 100,
      openedAt: Date.now(),
    }));

    return {
      totalValue: equity,
      cash,
      positions,
      realisedPnl: 0,
      unrealisedPnl: positions.reduce((s, p) => s + p.unrealisedPnl, 0),
      peakValue: equity,
      updatedAt: Date.now(),
    };
  }

  async placeOrder(params: PlaceOrderParams): Promise<Order> {
    const order: Order = {
      id: crypto.randomUUID(),
      asset: params.asset,
      pair: `${params.asset}/${params.quoteAsset}` as `${string}/${string}`,
      side: params.side,
      type: params.type,
      quantity: params.quantity,
      price: 0,
      status: OrderStatus.Pending,
      createdAt: Date.now(),
    };

    if (this.paper) {
      console.log(`[Alpaca][PAPER] ${params.side.toUpperCase()} ${params.quantity} ${params.asset} @ market`);
      order.status = OrderStatus.Filled;
      order.filledAt = Date.now();
      order.paperId = `PAPER-${order.id.slice(0, 8)}`;
      return order;
    }

    const extendedHours = !this.isRegularHours();
    let orderType = params.type === OrderType.Limit ? "limit" : "market";
    let limitPrice = params.limitPrice;

    if (extendedHours && orderType === "market") {
      orderType = "limit";
      limitPrice = await this.getPrice(params.asset, params.quoteAsset);
    }

    const res = await this.http.post<AlpacaOrderResponse>("/orders", {
      symbol: params.asset,
      qty: params.quantity,
      side: params.side,
      type: orderType,
      time_in_force: "day",
      ...(limitPrice && { limit_price: limitPrice }),
      ...(extendedHours && { extended_hours: true }),
    });

    // Market orders on Alpaca are often accepted but not yet filled — poll until filled
    const filled = res.data.status === "filled"
      ? res.data
      : await this.pollUntilFilled(res.data.id, 30_000);

    order.id = filled.id;
    order.price = Number(filled.filled_avg_price ?? 0);
    order.status = OrderStatus.Filled;
    order.filledAt = Date.now();
    return order;
  }

  private async pollUntilFilled(orderId: string, timeoutMs: number): Promise<AlpacaOrderResponse> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const res = await this.http.get<AlpacaOrderResponse>(`/orders/${orderId}`);
      const { status } = res.data;
      if (status === "filled") return res.data;
      if (status === "canceled" || status === "expired" || status === "rejected") {
        throw new Error(`[Alpaca] Order ${orderId} ${status}`);
      }
    }
    await this.cancelOrder(orderId).catch(() => {});
    throw new Error(`[Alpaca] Order ${orderId} fill timed out after ${timeoutMs}ms`);
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (!this.paper) {
      await this.http.delete(`/orders/${orderId}`);
    }
  }

  async subscribeTicks(
    asset: Asset,
    _quoteAsset: string,
    callback: (price: number, timestamp: number) => void
  ): Promise<() => void> {
    let ws: WebSocket | null = null;
    let closed = false;

    let retryDelay = 5000;

    const connect = () => {
      if (closed) return;
      // Paper accounts only have access to IEX; live accounts with SIP subscription use SIP.
      const feed = this.paper ? "iex" : "sip";
      ws = new WebSocket(`wss://stream.data.alpaca.markets/v2/${feed}`);

      ws.on("open", () => {
        retryDelay = 5000; // reset backoff on successful connection
        ws!.send(JSON.stringify({
          action: "auth",
          key: config.alpaca.apiKey,
          secret: config.alpaca.apiSecret,
        }));
      });

      ws.on("message", (data: Buffer) => {
        try {
          const msgs = JSON.parse(data.toString()) as AlpacaWSMessage[];
          for (const msg of msgs) {
            if (msg.T === "success" && msg.msg === "authenticated") {
              ws!.send(JSON.stringify({ action: "subscribe", trades: [asset] }));
            } else if (msg.T === "t" && msg.S === asset && msg.p != null) {
              callback(msg.p, new Date(msg.t ?? Date.now()).getTime());
            }
          }
        } catch {}
      });

      ws.on("error", (err) => {
        console.warn(`[Alpaca] Tick WS error for ${asset}: ${err.message}`);
        ws?.terminate(); // force close so the close handler fires and we reconnect
      });

      ws.on("close", () => {
        if (!closed) {
          setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 60_000); // exponential backoff, cap at 60s
        }
      });
    };

    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }

  async disconnect(): Promise<void> {
    console.log("[Alpaca] Disconnected");
  }

  private isRegularHours(): boolean {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);
    const weekday = parts.find((p) => p.type === "weekday")?.value;
    if (weekday === "Sat" || weekday === "Sun") return false;
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    const minuteOfDay = hour * 60 + minute;
    return minuteOfDay >= 570 && minuteOfDay < 960; // 9:30–16:00 ET
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RETRYABLE = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ERR_NETWORK", "ENOTFOUND", "EAI_AGAIN"]);

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 2000): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? "";
      const status = (err as { response?: { status: number } }).response?.status;
      const retryable = RETRYABLE.has(code) || status === 429 || status === 503;
      if (!retryable || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

function toAlpacaTimeframe(minutes: number): string {
  if (minutes < 60) return `${minutes}Min`;
  if (minutes % 60 === 0) return `${minutes / 60}Hour`;
  return `${minutes}Min`;
}

