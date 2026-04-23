import axios, { type AxiosInstance } from "axios";
import WebSocket from "ws";
import type { Asset, Candle, Order, Portfolio, Position } from "@trading-bot/shared";
import { OrderSide, OrderStatus, OrderType } from "@trading-bot/shared";
import type { IBroker, PlaceOrderParams } from "./broker.interface.js";
import { config } from "../config.js";

export class AlpacaBroker implements IBroker {
  private http!: AxiosInstance;   // trading (account, orders, positions)
  private dataHttp!: AxiosInstance; // market data (bars, trades)
  private readonly paper: boolean;

  constructor(paper = true) {
    this.paper = paper;
  }

  async connect(): Promise<void> {
    const tradingBaseURL = this.paper
      ? "https://paper-api.alpaca.markets/v2"
      : "https://api.alpaca.markets/v2";

    const headers = {
      "APCA-API-KEY-ID": config.alpaca.apiKey,
      "APCA-API-SECRET-KEY": config.alpaca.apiSecret,
      "Accept": "application/json",
    };

    this.http = axios.create({ baseURL: tradingBaseURL, headers });
    this.dataHttp = axios.create({ baseURL: "https://data.alpaca.markets/v2", headers });

    const res = await this.http.get<AlpacaAccount>("/account");
    console.log(`[Alpaca] Connected — paper=${this.paper}, equity=$${Number(res.data.equity).toFixed(2)}`);
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
      totalValueAUD: equity,
      cashAUD: cash,
      positions,
      realisedPnlAUD: 0,
      unrealisedPnlAUD: positions.reduce((s, p) => s + p.unrealisedPnl, 0),
      peakValueAUD: equity,
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

    const res = await this.http.post<AlpacaOrderResponse>("/orders", {
      symbol: params.asset,
      qty: params.quantity,
      side: params.side,
      type: params.type === OrderType.Limit ? "limit" : "market",
      time_in_force: "day",
      ...(params.limitPrice && { limit_price: params.limitPrice }),
    });

    order.id = res.data.id;
    order.price = Number(res.data.filled_avg_price ?? 0);
    order.status = res.data.status === "filled" ? OrderStatus.Filled : OrderStatus.Pending;
    if (order.status === OrderStatus.Filled) order.filledAt = Date.now();
    return order;
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

    const connect = () => {
      if (closed) return;
      // SIP feed = consolidated all-exchange data, consistent with bar prices.
      // Paper accounts get real-time SIP for free.
      ws = new WebSocket("wss://stream.data.alpaca.markets/v2/sip");

      ws.on("open", () => {
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
            if (msg.T === "authenticated") {
              ws!.send(JSON.stringify({ action: "subscribe", trades: [asset] }));
            } else if (msg.T === "t" && msg.S === asset && msg.p != null) {
              callback(msg.p, new Date(msg.t ?? Date.now()).getTime());
            }
          }
        } catch {}
      });

      ws.on("error", (err) => {
        console.warn(`[Alpaca] Tick WS error for ${asset}: ${err.message}`);
      });

      ws.on("close", () => {
        if (!closed) setTimeout(connect, 5000);
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
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RETRYABLE = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ERR_NETWORK"]);

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

// ─── Alpaca API types ─────────────────────────────────────────────────────────

interface AlpacaAccount {
  equity: string;
  cash: string;
  portfolio_value: string;
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface AlpacaBarsResponse {
  bars: AlpacaBar[];
  symbol: string;
  next_page_token: string | null;
}

interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  unrealized_pl: string;
  unrealized_plpc: string;
}

interface AlpacaLatestTrade {
  trade: { p: number; t: string };
}

interface AlpacaOrderResponse {
  id: string;
  status: string;
  filled_avg_price: string | null;
}

interface AlpacaWSMessage {
  T: string;
  S?: string;
  p?: number;
  t?: string;
}
