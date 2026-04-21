import type { Portfolio, PaperPortfolio, TradeSignal, RiskMetrics } from "@trading-bot/shared";
import { SignalType, OrderSide } from "@trading-bot/shared";
import type { PlaceOrderParams } from "../brokers/broker.interface.js";
import { OrderType } from "@trading-bot/shared";
import { config } from "../config.js";

export interface RiskDecision {
  approved: boolean;
  reason: string;
  params?: PlaceOrderParams;
}

export class RiskManager {
  private dailyStartValueAUD: number = 0;
  private dailyResetAt: number = 0;
  private halted = false;
  private haltReason: string | null = null;

  constructor(
    private portfolioRef: () => Portfolio,
    private paperPortfolioRef?: () => PaperPortfolio,
  ) {}

  reset(portfolioValue: number): void {
    this.dailyStartValueAUD = portfolioValue;
    this.dailyResetAt = Date.now();
    this.halted = false;
    this.haltReason = null;
    console.log(`[RiskManager] Daily reset — start value $${portfolioValue.toFixed(2)} AUD`);
  }

  evaluate(signal: TradeSignal): RiskDecision {
    if (signal.type === SignalType.Hold) {
      return { approved: false, reason: "Signal is Hold" };
    }

    if (this.halted) {
      return { approved: false, reason: `Circuit breaker active: ${this.haltReason}` };
    }

    const portfolio = this.portfolioRef();
    const positions = (this.paperPortfolioRef ?? this.portfolioRef)().positions;

    // ── Reset daily tracking at midnight AEST ────────────────────────────
    this.maybeResetDaily(portfolio.totalValueAUD);

    // ── Guardrail 1: daily loss limit ────────────────────────────────────
    const dailyPnlPct = this.dailyPnlPct(portfolio.totalValueAUD);
    if (dailyPnlPct <= -config.risk.maxDailyLossPct) {
      this.halt(`Daily loss limit reached (${dailyPnlPct.toFixed(2)}%)`);
      return { approved: false, reason: this.haltReason! };
    }

    // ── Guardrail 2: peak drawdown ───────────────────────────────────────
    const drawdownPct = this.drawdownPct(portfolio);
    if (drawdownPct >= config.risk.maxDrawdownPct) {
      this.halt(`Max drawdown reached (${drawdownPct.toFixed(2)}%)`);
      return { approved: false, reason: this.haltReason! };
    }

    // ── Guardrail 3: no duplicate positions ──────────────────────────────
    const alreadyLong = positions.find(
      (p) => p.asset === signal.asset && p.side === OrderSide.Buy
    );
    if (signal.type === SignalType.Buy && alreadyLong) {
      return { approved: false, reason: `Already holding ${signal.asset} long position` };
    }

    const alreadyShort = positions.find(
      (p) => p.asset === signal.asset && p.side === OrderSide.Sell
    );
    if (signal.type === SignalType.Sell && alreadyShort) {
      return { approved: false, reason: `Already have short exposure on ${signal.asset}` };
    }

    // ── Guardrail 4: minimum holding period ──────────────────────────────
    const minHoldMs = config.risk.minHoldCandles * config.hmm.candleResolutionMinutes * 60 * 1000;
    const openPosition = alreadyLong ?? alreadyShort;
    if (signal.type === SignalType.Sell && openPosition && Date.now() - openPosition.openedAt < minHoldMs) {
      const heldMins = Math.round((Date.now() - openPosition.openedAt) / 60_000);
      const minMins = config.risk.minHoldCandles * config.hmm.candleResolutionMinutes;
      return { approved: false, reason: `Min hold period not met for ${signal.asset} (${heldMins}m < ${minMins}m)` };
    }

    // ── Guardrail 5: position sizing ─────────────────────────────────────
    const paperPortfolio = this.paperPortfolioRef?.();
    const maxAUD = ((paperPortfolio?.totalValueAUD ?? portfolio.totalValueAUD) * config.risk.maxPositionSizePct) / 100;
    const availableAUD = Math.min(paperPortfolio?.cashAUD ?? portfolio.cashAUD, maxAUD);

    if (availableAUD < 10) {
      return { approved: false, reason: "Insufficient AUD balance for minimum position" };
    }

    const quantity = availableAUD / signal.price;

    return {
      approved: true,
      reason: `Approved: ${signal.type} ${signal.asset} qty=${quantity.toFixed(6)}`,
      params: {
        asset: signal.asset,
        quoteAsset: signal.pair.split("/")[1],
        side: signal.type === SignalType.Buy ? OrderSide.Buy : OrderSide.Sell,
        type: OrderType.Market,
        quantity,
      },
    };
  }

  getMetrics(): RiskMetrics {
    const portfolio = this.portfolioRef();
    return {
      dailyPnlAUD: portfolio.totalValueAUD - this.dailyStartValueAUD,
      dailyPnlPct: this.dailyPnlPct(portfolio.totalValueAUD),
      drawdownFromPeakPct: this.drawdownPct(portfolio),
      isHalted: this.halted,
      haltReason: this.haltReason,
      dailyLossLimitPct: config.risk.maxDailyLossPct,
      maxDrawdownPct: config.risk.maxDrawdownPct,
    };
  }

  private maybeResetDaily(currentValue: number): void {
    const now = new Date();
    const lastReset = new Date(this.dailyResetAt);
    // Reset if we've crossed midnight
    if (now.getDate() !== lastReset.getDate() || this.dailyResetAt === 0) {
      this.reset(currentValue);
    }
  }

  private dailyPnlPct(currentValue: number): number {
    if (this.dailyStartValueAUD === 0) return 0;
    return ((currentValue - this.dailyStartValueAUD) / this.dailyStartValueAUD) * 100;
  }

  private drawdownPct(portfolio: Portfolio): number {
    if (portfolio.peakValueAUD === 0) return 0;
    return ((portfolio.peakValueAUD - portfolio.totalValueAUD) / portfolio.peakValueAUD) * 100;
  }

  private halt(reason: string): void {
    this.halted = true;
    this.haltReason = reason;
    console.error(`[RiskManager] HALTED — ${reason}`);
  }
}
