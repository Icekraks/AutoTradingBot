import type { Portfolio, PaperPortfolio, TradeSignal, RiskMetrics } from "@trading-bot/shared";
import { SignalType, OrderSide } from "@trading-bot/shared";
import { OrderType } from "@trading-bot/shared";
import { config } from "../config.js";
import type { RiskDecision } from "./risk.types.js";

export type { RiskDecision };

export class RiskManager {
  private dailyStartValue: number = 0;
  private dailyResetAt: number = 0;
  private halted = false;
  private haltReason: string | null = null;

  constructor(
    private portfolioRef: () => Portfolio,
    private paperPortfolioRef?: () => PaperPortfolio | undefined,
  ) {}

  reset(portfolioValue: number): void {
    this.dailyStartValue = portfolioValue;
    this.dailyResetAt = Date.now();
    this.halted = false;
    this.haltReason = null;
    console.log(`[RiskManager] Daily reset — start value $${portfolioValue.toFixed(2)}`);
  }

  evaluate(signal: TradeSignal): RiskDecision {
    const portfolio = this.portfolioRef();

    // ── Reset daily tracking at midnight AEST ────────────────────────────
    this.maybeResetDaily(portfolio.totalValue);

    if (signal.type === SignalType.Hold) {
      return { approved: false, reason: "Signal is Hold" };
    }

    if (this.halted) {
      return { approved: false, reason: `Circuit breaker active: ${this.haltReason}` };
    }

    const positions = (this.paperPortfolioRef?.() ?? this.portfolioRef()).positions;

    // ── Guardrail 1: daily loss limit ────────────────────────────────────
    const dailyPnlPct = this.dailyPnlPct(portfolio.totalValue);
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

    // ── Guardrail 3: long-only — no duplicate longs, no sells without a position ─
    const alreadyLong = positions.find(
      (p) => p.asset === signal.asset && p.side === OrderSide.Buy
    );
    if (signal.type === SignalType.Buy && alreadyLong) {
      return { approved: false, reason: `Already holding ${signal.asset} long position` };
    }
    if (signal.type === SignalType.Sell && !alreadyLong) {
      return { approved: false, reason: `No ${signal.asset} long position to exit` };
    }

    // ── Guardrail 4: minimum holding period ──────────────────────────────
    const minHoldMs = config.risk.minHoldCandles * config.hmm.slowCandleResolutionMinutes * 60 * 1000;
    const openPosition = alreadyLong;
    if (signal.type === SignalType.Sell && openPosition && openPosition.unrealisedPnl >= 0 && Date.now() - openPosition.openedAt < minHoldMs) {
      const heldMins = Math.round((Date.now() - openPosition.openedAt) / 60_000);
      const minMins = config.risk.minHoldCandles * config.hmm.slowCandleResolutionMinutes;
      return { approved: false, reason: `Min hold period not met for ${signal.asset} (${heldMins}m < ${minMins}m)` };
    }

    // ── Guardrail 5: position sizing (buy only) ──────────────────────────
    const paperPortfolio = this.paperPortfolioRef?.();
    const maxPosition = ((paperPortfolio?.totalValue ?? portfolio.totalValue) * config.risk.maxPositionSizePct) / 100;
    const available = Math.min(paperPortfolio?.cash ?? portfolio.cash, maxPosition);

    if (signal.type === SignalType.Buy && available < 10) {
      return { approved: false, reason: "Insufficient balance for minimum position" };
    }

    // ── Guardrail 6: sector exposure cap ─────────────────────────────────
    if (signal.type === SignalType.Buy) {
      const currentExposure = positions.reduce((sum, p) => sum + p.currentPrice * p.quantity, 0);
      const totalValue = paperPortfolio?.totalValue ?? portfolio.totalValue;
      const projectedExposurePct = ((currentExposure + available) / totalValue) * 100;
      if (projectedExposurePct > config.risk.maxSectorExposurePct) {
        return {
          approved: false,
          reason: `Sector exposure cap reached (${projectedExposurePct.toFixed(1)}% > ${config.risk.maxSectorExposurePct}%)`,
        };
      }
    }

    const quantity = signal.type === SignalType.Sell && alreadyLong
      ? alreadyLong.quantity
      : available / signal.price;

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
      dailyPnl: portfolio.totalValue - this.dailyStartValue,
      dailyPnlPct: this.dailyPnlPct(portfolio.totalValue),
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
    if (this.dailyStartValue === 0) return 0;
    return ((currentValue - this.dailyStartValue) / this.dailyStartValue) * 100;
  }

  private drawdownPct(portfolio: Portfolio): number {
    if (portfolio.peakValue === 0) return 0;
    return Math.max(0, ((portfolio.peakValue - portfolio.totalValue) / portfolio.peakValue) * 100);
  }

  checkPostExit(): void {
    const portfolio = this.portfolioRef();
    this.maybeResetDaily(portfolio.totalValue);
    const dailyPnlPct = this.dailyPnlPct(portfolio.totalValue);
    if (dailyPnlPct <= -config.risk.maxDailyLossPct) {
      this.halt(`Daily loss limit reached post-exit (${dailyPnlPct.toFixed(2)}%)`);
    }
    const drawdownPct = this.drawdownPct(portfolio);
    if (drawdownPct >= config.risk.maxDrawdownPct) {
      this.halt(`Max drawdown reached post-exit (${drawdownPct.toFixed(2)}%)`);
    }
  }

  serialise() {
    return {
      dailyStartValue: this.dailyStartValue,
      dailyResetAt: this.dailyResetAt,
      halted: this.halted,
      haltReason: this.haltReason,
    };
  }

  restore(state: ReturnType<RiskManager["serialise"]>): void {
    this.dailyStartValue = state.dailyStartValue;
    this.dailyResetAt = state.dailyResetAt;
    this.halted = state.halted;
    this.haltReason = state.haltReason;
  }

  private halt(reason: string): void {
    this.halted = true;
    this.haltReason = reason;
    console.error(`[RiskManager] HALTED — ${reason}`);
  }
}
