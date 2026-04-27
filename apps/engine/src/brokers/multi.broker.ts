import type { Asset, BrokerPortfolio, Candle, Order, Portfolio } from "@trading-bot/shared";
import type { IBroker, PlaceOrderParams } from "./broker.interface.js";
import { SwyftxBroker } from "./swyftx.broker.js";
import { AlpacaBroker } from "./alpaca.broker.js";
import { config } from "../config.js";

/**
 * Routes each asset to the correct broker — Alpaca for stocks, Swyftx for crypto.
 * The engine sees a single unified IBroker; portfolios are merged on read.
 */
export class MultiBroker implements IBroker {
  private swyftx: SwyftxBroker;
  private alpaca: AlpacaBroker;
  private alpacaAssets: Set<Asset>;

  constructor(paperMode: boolean) {
    this.swyftx = new SwyftxBroker(paperMode);
    this.alpaca = new AlpacaBroker(config.alpaca.paper);
    this.alpacaAssets = new Set(config.alpaca.assets);
  }

  private brokerFor(asset: Asset): IBroker {
    return this.alpacaAssets.has(asset) ? this.alpaca : this.swyftx;
  }

  async connect(): Promise<void> {
    await Promise.all([this.swyftx.connect(), this.alpaca.connect()]);
  }

  async getCandles(
    asset: Asset,
    quoteAsset: string,
    resolutionMinutes: number,
    count: number
  ): Promise<Candle[]> {
    return this.brokerFor(asset).getCandles(asset, quoteAsset, resolutionMinutes, count);
  }

  async getPrice(asset: Asset, quoteAsset: string): Promise<number> {
    return this.brokerFor(asset).getPrice(asset, quoteAsset);
  }

  async getPortfolio(): Promise<Portfolio> {
    const [sp, ap] = await Promise.all([
      this.swyftx.getPortfolio(),
      this.alpaca.getPortfolio(),
    ]);

    const cryptoPositions = sp.positions.map((p) => ({ ...p, broker: "Crypto" }));
    const stocksPositions = ap.positions.map((p) => ({ ...p, broker: "Stocks" }));

    const brokers: BrokerPortfolio[] = [
      { name: "Crypto", totalValue: sp.totalValue, cash: sp.cash, positions: cryptoPositions, realisedPnl: sp.realisedPnl, unrealisedPnl: sp.unrealisedPnl },
      { name: "Stocks", totalValue: ap.totalValue, cash: ap.cash, positions: stocksPositions, realisedPnl: ap.realisedPnl, unrealisedPnl: ap.unrealisedPnl },
    ];

    return {
      totalValue: sp.totalValue + ap.totalValue,
      cash: sp.cash + ap.cash,
      positions: [...cryptoPositions, ...stocksPositions],
      realisedPnl: sp.realisedPnl + ap.realisedPnl,
      unrealisedPnl: sp.unrealisedPnl + ap.unrealisedPnl,
      peakValue: sp.peakValue + ap.peakValue,
      updatedAt: Date.now(),
      brokers,
    };
  }

  async placeOrder(params: PlaceOrderParams): Promise<Order> {
    return this.brokerFor(params.asset).placeOrder(params);
  }

  async cancelOrder(orderId: string): Promise<void> {
    // Try both — only the correct broker will find the order
    await Promise.allSettled([
      this.swyftx.cancelOrder(orderId),
      this.alpaca.cancelOrder(orderId),
    ]);
  }

  async subscribeTicks(
    asset: Asset,
    quoteAsset: string,
    callback: (price: number, timestamp: number) => void
  ): Promise<() => void> {
    return this.brokerFor(asset).subscribeTicks(asset, quoteAsset, callback);
  }

  setBrokerPaper(brokerName: string, paper: boolean): void {
    if (brokerName === "Stocks") this.alpaca.setBrokerPaper(brokerName, paper);
    else if (brokerName === "Crypto") this.swyftx.setBrokerPaper(brokerName, paper);
  }

  async disconnect(): Promise<void> {
    await Promise.all([this.swyftx.disconnect(), this.alpaca.disconnect()]);
  }
}
