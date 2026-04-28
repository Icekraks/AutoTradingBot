/**
 * Swyftx broker adapter.
 * API reference: https://docs.swyftx.com.au
 * Verify endpoint paths against the official docs before going live.
 */
import axios, { type AxiosInstance } from "axios";
import WebSocket from "ws";
import type { Asset, Candle, Order, Portfolio } from "@trading-bot/shared";
import { OrderSide, OrderStatus, OrderType } from "@trading-bot/shared";
import type { IBroker, PlaceOrderParams } from "./broker.interface.js";
import type { KrakenOHLCRow, KrakenOHLCResponse, KrakenWSTicker, SwyftxAsset, SwyftxBalance, SwyftxOrderResponse, SwyftxTickerResponse } from "./swyftx.types.js";
import { config } from "../config.js";

export class SwyftxBroker implements IBroker {
  private http!: AxiosInstance;
  private accessToken = "";
  private paperMode: boolean;
  private assetIdMap: Map<string, number> = new Map(); // code → assetId

  constructor(paperMode = true) {
    this.paperMode = paperMode;
  }

  async connect(): Promise<void> {
    // Auth always goes to the live API — demo has no /auth/refresh/ endpoint.
    // Paper mode only affects order execution, not which API we read data from.
    this.http = axios.create({
      baseURL: config.swyftx.baseUrl,
      headers: {
        // No Content-Type on the instance default — setting it on GETs triggers Cloudflare WAF.
        // It is set explicitly only on POST requests below.
        "Accept": "application/json",
        "Origin": "https://swyftx.com.au",
        "Referer": "https://swyftx.com.au/",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
    await this.authenticate();
    await this.fetchAssetMap();
    const quote = config.trading.quoteAsset;
    console.log(`[Swyftx] Connected — paper=${this.paperMode}, ${quote} assetId=${this.assetIdMap.get(quote)}`);
  }

  private async fetchAssetMap(): Promise<void> {
    const res = await this.http.get<SwyftxAsset[]>("/markets/assets/");
    for (const asset of res.data) {
      this.assetIdMap.set(asset.code, asset.id);
    }
  }

  private async authenticate(): Promise<void> {
    // Reuse cached token from env if it's still valid — avoids /auth/refresh/ rate limit
    const cached = process.env.SWFTYX_API_TOKEN;
    if (cached && !this.isTokenExpired(cached)) {
      this.accessToken = cached;
      this.http.defaults.headers.common["Authorization"] = `Bearer ${this.accessToken}`;
      return;
    }

    const res = await this.http.post<{ accessToken: string }>(
      "/auth/refresh/",
      { apiKey: config.swyftx.apiKey },
      { headers: { "Content-Type": "application/json" } }
    );
    this.accessToken = res.data.accessToken;
    this.http.defaults.headers.common["Authorization"] = `Bearer ${this.accessToken}`;
  }

  private isTokenExpired(token: string): boolean {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString()) as { exp: number };
      return Date.now() >= payload.exp * 1000 - 60_000; // treat as expired 1 min early
    } catch {
      return true;
    }
  }

  async getCandles(
    asset: Asset,
    quoteAsset: string,
    resolutionMinutes: number,
    count: number
  ): Promise<Candle[]> {
    // Swyftx's /charts/getBars/ is Cloudflare-blocked for server-side requests.
    // Kraken's public OHLC API is free, requires no auth, and has native AUD pairs.
    const krakenPair = KRAKEN_PAIR[`${asset}/${quoteAsset}`];
    if (!krakenPair) {
      throw new Error(`No Kraken pair mapping for ${asset}/${quoteAsset}`);
    }

    const res = await axios.get<KrakenOHLCResponse>(
      "https://api.kraken.com/0/public/OHLC",
      { params: { pair: krakenPair, interval: resolutionMinutes } }
    );

    if (res.data.error?.length) {
      throw new Error(`Kraken OHLC error: ${res.data.error.join(", ")}`);
    }

    const resultKey = Object.keys(res.data.result).find((k) => k !== "last") ?? krakenPair;
    const rows: KrakenOHLCRow[] = res.data.result[resultKey] ?? [];
    const candles: Candle[] = rows.map(([time, open, high, low, close, , volume]) => ({
      timestamp: time * 1000,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    }));

    // Kraken returns up to 720 bars newest-last; take the most recent `count`
    return candles.slice(-count);
  }

  async getPrice(asset: Asset, quoteAsset: string): Promise<number> {
    const res = await this.http.get<SwyftxTickerResponse>(
      `/markets/info/basic/${asset}/${quoteAsset}/`
    );
    return Number(res.data.lastPrice);
  }

  async getPortfolio(): Promise<Portfolio> {
    const res = await this.http.get<SwyftxBalance[]>("/user/balance/");
    const quoteId = this.assetIdMap.get(config.trading.quoteAsset);
    const quoteBalance = res.data.find((b) => b.assetId === quoteId);
    const balance = quoteBalance ? Number(quoteBalance.availableBalance) : 0;

    return {
      totalValue: balance,
      cash: balance,
      positions: [],
      realisedPnl: 0,
      unrealisedPnl: 0,
      peakValue: balance,
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
      price: params.limitPrice ?? 0,
      status: OrderStatus.Pending,
      createdAt: Date.now(),
    };

    if (this.paperMode) {
      console.log(
        `[Swyftx][PAPER] ${params.side.toUpperCase()} ${params.quantity} ${params.asset} @ market`
      );
      order.status = OrderStatus.Filled;
      order.filledAt = Date.now();
      order.paperId = `PAPER-${order.id.slice(0, 8)}`;
      return order;
    }

    const isBuy = params.side === OrderSide.Buy;

    // Swyftx convention: primary = quote currency (USD), secondary = traded asset (BTC).
    // quantity is always denominated in the secondary (base) asset.
    const [res, fillPrice] = await Promise.all([
      this.http.post<SwyftxOrderResponse>(
        "/orders/",
        {
          primary: params.quoteAsset,        // e.g. "USD"
          secondary: params.asset,            // e.g. "BTC"
          quantity: String(params.quantity),  // base asset amount, as string
          assetQuantity: params.asset,        // quantity is in secondary (base asset)
          // Swyftx API uses numeric codes: 1 = instant buy, 2 = instant sell
          orderType: isBuy ? 1 : 2,
          ...(params.limitPrice && { trigger: String(params.limitPrice) }),
        },
        { headers: { "Content-Type": "application/json" } }
      ),
      this.getPrice(params.asset, params.quoteAsset).catch(() => 0),
    ]);

    order.id = res.data.orderUuid;
    order.price = params.limitPrice ?? fillPrice;
    // processed=false means order is queued but not yet settled; treat as Filled for tracking
    // (Swyftx instant orders settle near-immediately, but the flag can be false on creation)
    order.status = res.data.processed ? OrderStatus.Filled : OrderStatus.Pending;
    order.filledAt = res.data.processed ? Date.now() : undefined;
    return order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (!this.paperMode) {
      await this.http.delete(`/orders/${orderId}/`);
    }
  }

  async subscribeTicks(
    asset: Asset,
    quoteAsset: string,
    callback: (price: number, timestamp: number) => void
  ): Promise<() => void> {
    const symbol = KRAKEN_WS_SYMBOL[`${asset}/${quoteAsset}`];
    if (!symbol) {
      console.warn(`[Swyftx] No Kraken WS symbol for ${asset}/${quoteAsset} — ticks unavailable`);
      return () => {};
    }

    let ws: WebSocket | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket("wss://ws.kraken.com/v2");

      ws.on("open", () => {
        ws!.send(JSON.stringify({
          method: "subscribe",
          params: { channel: "ticker", symbol: [symbol] },
        }));
      });

      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as KrakenWSTicker;
          if (msg.channel === "ticker" && Array.isArray(msg.data)) {
            for (const tick of msg.data) {
              if (tick.symbol === symbol && tick.last != null) {
                callback(tick.last, Date.now());
              }
            }
          }
        } catch {}
      });

      ws.on("error", (err) => {
        console.warn(`[Kraken] Tick WS error for ${asset}: ${err.message}`);
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

  setBrokerPaper(_brokerName: string, paper: boolean): void {
    if (this.paperMode === paper) return;
    this.paperMode = paper;
    console.log(`[Swyftx] Switched to ${paper ? "paper" : "live"} mode`);
  }

  async disconnect(): Promise<void> {
    console.log("[Swyftx] Disconnected");
  }
}

// ─── Kraken public OHLC ───────────────────────────────────────────────────────

// Kraken REST OHLC pair names
const KRAKEN_PAIR: Record<string, string> = {
  "BTC/AUD": "XBTAUD",
  "ETH/AUD": "ETHAUD",
  "BTC/USD": "XBTUSD",
  "ETH/USD": "ETHUSD",
  "XRP/USD": "XRPUSD",
  "SOL/USD": "SOLUSD",
  "ADA/USD": "ADAUSD",
};

// Kraken WebSocket v2 symbol names (BTC not XBT)
const KRAKEN_WS_SYMBOL: Record<string, string> = {
  "BTC/AUD": "BTC/AUD",
  "ETH/AUD": "ETH/AUD",
  "BTC/USD": "BTC/USD",
  "ETH/USD": "ETH/USD",
  "XRP/USD": "XRP/USD",
  "SOL/USD": "SOL/USD",
  "ADA/USD": "ADA/USD",
};

