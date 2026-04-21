import type { Asset, Order, PaperPortfolio, Position } from "@trading-bot/shared";
import { OrderSide } from "@trading-bot/shared";
import { config } from "../config.js";

export class PaperTracker {
  private startingAUD: number;
  private cashAUD: number;
  private positions: Map<Asset, Position> = new Map();
  private realisedPnlAUD = 0;

  constructor(startingAUD: number) {
    this.startingAUD = startingAUD;
    this.cashAUD = startingAUD;
  }

  onOrderFilled(order: Order, currentPrice: number): void {
    if (order.side === OrderSide.Buy) {
      this.openPosition(order, currentPrice);
    } else {
      this.closePosition(order, currentPrice);
    }
  }

  private openPosition(order: Order, price: number): void {
    const cost = order.quantity * price;
    if (cost > this.cashAUD) return; // insufficient paper cash

    this.cashAUD -= cost;

    const stopLoss = price * (1 - config.risk.stopLossPct / 100);
    const takeProfit = price * (1 + config.risk.takeProfitPct / 100);

    this.positions.set(order.asset, {
      asset: order.asset,
      pair: order.pair,
      side: order.side,
      quantity: order.quantity,
      entryPrice: price,
      currentPrice: price,
      stopLoss,
      takeProfit,
      unrealisedPnl: 0,
      unrealisedPnlPct: 0,
      openedAt: order.filledAt ?? Date.now(),
    });
  }

  private closePosition(order: Order, price: number): void {
    const pos = this.positions.get(order.asset);
    if (!pos) return;

    const proceeds = order.quantity * price;
    const cost = order.quantity * pos.entryPrice;
    this.realisedPnlAUD += proceeds - cost;
    this.cashAUD += proceeds;
    this.positions.delete(order.asset);
  }

  updatePrices(prices: Record<Asset, number>): void {
    for (const [asset, pos] of this.positions) {
      const price = prices[asset];
      if (price == null) continue;
      const unrealisedPnl = (price - pos.entryPrice) * pos.quantity;
      const unrealisedPnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      this.positions.set(asset, { ...pos, currentPrice: price, unrealisedPnl, unrealisedPnlPct });
    }
  }

  // Tick-based: fill at the live price that crossed the level
  checkPriceTrigger(asset: Asset, price: number): number | null {
    const pos = this.positions.get(asset);
    if (!pos) return null;
    if (price <= pos.stopLoss || price >= pos.takeProfit) return price;
    return null;
  }

  // Candle-based: fill at the stop/TP level (not the close) for realistic simulation
  checkCandleTrigger(asset: Asset, candleLow: number, candleHigh: number): number | null {
    const pos = this.positions.get(asset);
    if (!pos) return null;
    if (candleLow <= pos.stopLoss) return pos.stopLoss;
    if (candleHigh >= pos.takeProfit) return pos.takeProfit;
    return null;
  }

  getPortfolio(): PaperPortfolio {
    const positions = Array.from(this.positions.values());
    const unrealisedPnlAUD = positions.reduce((sum, p) => sum + p.unrealisedPnl, 0);
    const positionsValueAUD = positions.reduce((sum, p) => sum + p.currentPrice * p.quantity, 0);

    return {
      startingAUD: this.startingAUD,
      cashAUD: this.cashAUD,
      positions,
      realisedPnlAUD: this.realisedPnlAUD,
      unrealisedPnlAUD,
      totalValueAUD: this.cashAUD + positionsValueAUD,
    };
  }

  hasPosition(asset: Asset): boolean {
    return this.positions.has(asset);
  }

  reset(startingAUD: number): void {
    this.startingAUD = startingAUD;
    this.cashAUD = startingAUD;
    this.positions.clear();
    this.realisedPnlAUD = 0;
  }
}
