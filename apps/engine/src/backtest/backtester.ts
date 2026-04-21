import type { Asset, Candle } from "@trading-bot/shared";
import { MarketRegime, SignalType, OrderSide } from "@trading-bot/shared";
import { RegimeDetector } from "../hmm/regime.js";
import { generateSignal } from "../signals/signal-generator.js";
import { config } from "../config.js";

export interface BacktestResult {
  asset: Asset;
  totalReturn: number;
  totalReturnPct: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  numTrades: number;
  winRate: number;
  trades: BacktestTrade[];
}

export interface BacktestTrade {
  asset: Asset;
  side: OrderSide;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnlAUD: number;
  pnlPct: number;
  entryTimestamp: number;
  exitTimestamp: number;
  entryRegime: MarketRegime;
}

interface SimPosition {
  side: OrderSide;
  entryPrice: number;
  quantity: number;
  entryTimestamp: number;
  entryRegime: MarketRegime;
  stopLoss: number;
  takeProfit: number;
}

export class Backtester {
  private trainSplit = 0.7; // 70% train, 30% test

  async run(asset: Asset, candles: Candle[], startCapitalAUD = 10_000): Promise<BacktestResult> {
    const splitIdx = Math.floor(candles.length * this.trainSplit);
    const trainCandles = candles.slice(0, splitIdx);
    const testCandles = candles.slice(splitIdx);

    console.log(`[Backtester:${asset}] Train: ${trainCandles.length} candles, Test: ${testCandles.length} candles`);

    const detector = new RegimeDetector(asset);
    detector.train(trainCandles);

    // Decode regimes over test period
    const allCandles = [...trainCandles, ...testCandles];
    const regimes = detector.decodeSequence(allCandles);
    const testRegimes = regimes.slice(trainCandles.length - 1); // -1 due to feature extraction offset

    const trades: BacktestTrade[] = [];
    let cashAUD = startCapitalAUD;
    let peakAUD = startCapitalAUD;
    let maxDrawdown = 0;
    let position: SimPosition | null = null;

    const pnlHistory: number[] = [];

    for (let i = 1; i < testCandles.length; i++) {
      const candle = testCandles[i];
      const regime = testRegimes[i] ?? MarketRegime.Sideways;
      const slidingWindow = allCandles.slice(0, splitIdx + i);

      const regimeState = {
        regime,
        probabilities: {
          [MarketRegime.Bull]: regime === MarketRegime.Bull ? 0.8 : 0.1,
          [MarketRegime.Bear]: regime === MarketRegime.Bear ? 0.8 : 0.1,
          [MarketRegime.Sideways]: regime === MarketRegime.Sideways ? 0.8 : 0.1,
        },
        confidence: 0.8,
        updatedAt: candle.timestamp,
      };

      const signal = generateSignal({
        asset,
        quoteAsset: "AUD",
        candles: slidingWindow,
        regime: regimeState,
      });

      // Check stop loss / take profit on open position
      if (position) {
        const pricedOut =
          (position.side === OrderSide.Buy && (candle.low <= position.stopLoss || candle.high >= position.takeProfit)) ||
          (position.side === OrderSide.Sell && (candle.high >= position.stopLoss || candle.low <= position.takeProfit));

        const exitSignal =
          (position.side === OrderSide.Buy && signal.type === SignalType.Sell) ||
          (position.side === OrderSide.Sell && signal.type === SignalType.Buy);

        if (pricedOut || exitSignal) {
          const exitPrice = pricedOut
            ? position.side === OrderSide.Buy
              ? candle.low <= position.stopLoss ? position.stopLoss : position.takeProfit
              : candle.high >= position.stopLoss ? position.stopLoss : position.takeProfit
            : candle.close;

          const pnl =
            position.side === OrderSide.Buy
              ? (exitPrice - position.entryPrice) * position.quantity
              : (position.entryPrice - exitPrice) * position.quantity;

          cashAUD += position.entryPrice * position.quantity + pnl;

          trades.push({
            asset,
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice,
            quantity: position.quantity,
            pnlAUD: pnl,
            pnlPct: (pnl / (position.entryPrice * position.quantity)) * 100,
            entryTimestamp: position.entryTimestamp,
            exitTimestamp: candle.timestamp,
            entryRegime: position.entryRegime,
          });

          pnlHistory.push(cashAUD);
          if (cashAUD > peakAUD) peakAUD = cashAUD;
          const drawdown = ((peakAUD - cashAUD) / peakAUD) * 100;
          if (drawdown > maxDrawdown) maxDrawdown = drawdown;

          position = null;
        }
      }

      // Open new position if no existing one
      if (!position && signal.type !== SignalType.Hold) {
        const maxPositionAUD = cashAUD * (config.risk.maxPositionSizePct / 100);
        const quantity = maxPositionAUD / candle.close;
        cashAUD -= maxPositionAUD;

        const stopLoss =
          signal.type === SignalType.Buy
            ? candle.close * (1 - config.risk.stopLossPct / 100)
            : candle.close * (1 + config.risk.stopLossPct / 100);

        const takeProfit =
          signal.type === SignalType.Buy
            ? candle.close * (1 + config.risk.takeProfitPct / 100)
            : candle.close * (1 - config.risk.takeProfitPct / 100);

        position = {
          side: signal.type === SignalType.Buy ? OrderSide.Buy : OrderSide.Sell,
          entryPrice: candle.close,
          quantity,
          entryTimestamp: candle.timestamp,
          entryRegime: regime,
          stopLoss,
          takeProfit,
        };
      }
    }

    // Close any open position at end
    if (position) {
      const lastCandle = testCandles[testCandles.length - 1];
      const pnl =
        position.side === OrderSide.Buy
          ? (lastCandle.close - position.entryPrice) * position.quantity
          : (position.entryPrice - lastCandle.close) * position.quantity;
      cashAUD += position.entryPrice * position.quantity + pnl;
    }

    const totalReturn = cashAUD - startCapitalAUD;
    const returns = pnlHistory.map((v, i) => (i === 0 ? 0 : (v - pnlHistory[i - 1]) / pnlHistory[i - 1]));
    const meanReturn = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
    const stdReturn = Math.sqrt(
      returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length || 1)
    );
    const sharpeRatio = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(252 * 48) : 0; // annualised (48 × 30min per day)

    const wins = trades.filter((t) => t.pnlAUD > 0).length;

    return {
      asset,
      totalReturn,
      totalReturnPct: (totalReturn / startCapitalAUD) * 100,
      sharpeRatio,
      maxDrawdownPct: maxDrawdown,
      numTrades: trades.length,
      winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      trades,
    };
  }
}
