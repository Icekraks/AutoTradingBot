/**
 * Swyftx broker adapter.
 * API reference: https://docs.swyftx.com.au
 * Verify endpoint paths against the official docs before going live.
 */
import axios, { type AxiosInstance } from "axios";
import WebSocket from "ws";
import type { Asset, Candle, Order, Portfolio } from "@trading-bot/shared";
import { OrderStatus, OrderType } from "@trading-bot/shared";
import type { IBroker, PlaceOrderParams } from "./broker.interface.js";
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
    const res = await this.http.post<{ accessToken: string }>(
      "/auth/refresh/",
      { apiKey: config.swyftx.apiKey },
      { headers: { "Content-Type": "application/json" } }
    );
    this.accessToken = res.data.accessToken;
    this.http.defaults.headers.common["Authorization"] = `Bearer ${this.accessToken}`;
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
    const cashAUD = quoteBalance ? Number(quoteBalance.availableBalance) : 0;

    return {
      totalValueAUD: cashAUD,
      cashAUD,
      positions: [],
      realisedPnlAUD: 0,
      unrealisedPnlAUD: 0,
      peakValueAUD: cashAUD,
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

    const res = await this.http.post<{ orderId: string }>(
      "/orders/",
      {
      primary: params.asset,
      secondary: params.quoteAsset,
      quantity: params.quantity,
      orderType: params.type === OrderType.Market ? "MARKET" : "LIMIT",
      side: params.side,
      ...(params.limitPrice && { limitPrice: params.limitPrice }),
      },
      { headers: { "Content-Type": "application/json" } }
    );

    order.id = res.data.orderId;
    order.status = OrderStatus.Filled;
    order.filledAt = Date.now();
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
    const ws = new WebSocket(`${config.swyftx.wsUrl}/`);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          channel: "ticker",
          asset,
          secondary: quoteAsset,
        })
      );
    });

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as SwyftxTickMessage;
        if (msg.type === "ticker" && msg.asset === asset) {
          callback(Number(msg.lastPrice), Date.now());
        }
      } catch {}
    });

    return () => ws.close();
  }

  async disconnect(): Promise<void> {
    console.log("[Swyftx] Disconnected");
  }
}

// ─── Kraken public OHLC ───────────────────────────────────────────────────────

const KRAKEN_PAIR: Record<string, string> = {
  "BTC/AUD": "XBTAUD",
  "ETH/AUD": "ETHAUD",
  "BTC/USD": "XBTUSD",
  "ETH/USD": "ETHUSD",
  "XRP/USD": "XRPUSD",
  "SOL/USD": "SOLUSD",
  "ADA/USD": "ADAUSD",
};

// Each row: [time, open, high, low, close, vwap, volume, count]
type KrakenOHLCRow = [number, string, string, string, string, string, string, number];

interface KrakenOHLCResponse {
  error: string[];
  result: Record<string, KrakenOHLCRow[]>;
}

// ─── Swyftx API response shapes ──────────────────────────────────────────────

interface SwyftxTickerResponse {
  lastPrice: string;
}

interface SwyftxBalance {
  assetId: number;
  availableBalance: string;
  stakingBalance: string;
}

interface SwyftxAsset {
  id: number;
  code: string;
}

interface SwyftxTickMessage {
  type: string;
  asset: string;
  lastPrice: string;
}
