import type { Asset, Order, PaperPortfolio, Position } from "@trading-bot/shared";
import { OrderSide } from "@trading-bot/shared";
import { config } from "../config.js";

export class PaperTracker {
  private starting: number;
  private cash: number;
  private positions: Map<Asset, Position> = new Map();
  private realisedPnl = 0;
  private readonly brokerName: string;
  private readonly feeRatePct: number;

  constructor(starting: number, brokerName = "Crypto", feeRatePct = 0) {
    this.starting = starting;
    this.cash = starting;
    this.brokerName = brokerName;
    this.feeRatePct = feeRatePct;
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
    const fee = cost * (this.feeRatePct / 100);
    if (cost + fee > this.cash) return; // insufficient paper cash

    this.cash -= cost + fee;

    const slPct = this.brokerName === "Crypto" ? config.risk.stopLossPctCrypto : config.risk.stopLossPct;
    const tpPct = this.brokerName === "Crypto" ? config.risk.takeProfitPctCrypto : config.risk.takeProfitPct;
    const stopLoss = price * (1 - slPct / 100);
    const takeProfit = price * (1 + tpPct / 100);

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
      broker: this.brokerName,
    });
  }

  private closePosition(order: Order, price: number): void {
    const pos = this.positions.get(order.asset);
    if (!pos) return;

    const qty = pos.quantity; // always close the exact position size
    const proceeds = qty * price;
    const fee = proceeds * (this.feeRatePct / 100);
    const cost = qty * pos.entryPrice;
    this.realisedPnl += proceeds - fee - cost;
    this.cash += proceeds - fee;
    this.positions.delete(order.asset);
  }

  updatePrices(prices: Record<Asset, number>): void {
    for (const [asset, pos] of this.positions) {
      const price = prices[asset];
      if (price == null) continue;
      const unrealisedPnl = (price - pos.entryPrice) * pos.quantity;
      const unrealisedPnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;

      const trailingStopPct = this.brokerName === "Stocks"
        ? config.risk.trailingStopPct
        : config.risk.trailingStopPctCrypto;
      let stopLoss = pos.stopLoss;
      if (unrealisedPnlPct >= config.risk.trailingBreakevenPct) {
        stopLoss = Math.max(stopLoss, pos.entryPrice);
      }
      if (unrealisedPnlPct >= config.risk.trailingBreakevenPct + trailingStopPct) {
        stopLoss = Math.max(stopLoss, price * (1 - trailingStopPct / 100));
      }

      this.positions.set(asset, { ...pos, currentPrice: price, unrealisedPnl, unrealisedPnlPct, stopLoss });
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
    const unrealisedPnl = positions.reduce((sum, p) => sum + p.unrealisedPnl, 0);
    const positionsValue = positions.reduce((sum, p) => sum + p.currentPrice * p.quantity, 0);

    return {
      starting: this.starting,
      cash: this.cash,
      positions,
      realisedPnl: this.realisedPnl,
      unrealisedPnl,
      totalValue: this.cash + positionsValue,
    };
  }

  hasPosition(asset: Asset): boolean {
    return this.positions.has(asset);
  }

  reset(starting: number): void {
    this.starting = starting;
    this.cash = starting;
    this.positions.clear();
    this.realisedPnl = 0;
  }

  serialise() {
    return {
      starting: this.starting,
      cash: this.cash,
      realisedPnl: this.realisedPnl,
      positions: Array.from(this.positions.values()),
    };
  }

  restore(data: ReturnType<PaperTracker["serialise"]> & Record<string, unknown>): void {
    // Support both new names and old AUD-suffixed names from state files written before the rename
    this.starting = (data.starting ?? (data.startingAUD as number)) || 0;
    this.cash = (data.cash ?? (data.cashAUD as number)) || this.starting;
    this.realisedPnl = (data.realisedPnl ?? (data.realisedPnlAUD as number)) || 0;
    this.positions = new Map((data.positions as Position[]).map((p) => [p.asset, p]));
    console.log(`[PaperTracker:${this.brokerName}] Restored — cash=$${this.cash.toFixed(2)}, positions=${this.positions.size}`);
  }
}
