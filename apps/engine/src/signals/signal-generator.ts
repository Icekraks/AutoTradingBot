import type { Asset, Candle, TradingPair } from "@trading-bot/shared";
import { MarketRegime, SignalType, type TradeSignal } from "@trading-bot/shared";
import type { RegimeState } from "@trading-bot/shared";

const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;

/** Wilder's RSI */
function calculateRSI(closes: number[], period = RSI_PERIOD): number {
  if (closes.length < period + 1) return 50; // not enough data — neutral

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface SignalContext {
  asset: Asset;
  quoteAsset: string;
  candles: Candle[];
  regime: RegimeState;
}

export function generateSignal(ctx: SignalContext): TradeSignal {
  const { asset, quoteAsset, candles, regime } = ctx;
  const pair: TradingPair = `${asset}/${quoteAsset}`;
  const latestClose = candles[candles.length - 1].close;
  const closes = candles.map((c) => c.close);
  const rsi = calculateRSI(closes);

  let type = SignalType.Hold;
  let reason = `Regime: ${regime.regime}, RSI: ${rsi.toFixed(1)}`;

  if (regime.regime === MarketRegime.Bull && rsi < RSI_OVERBOUGHT && regime.confidence > 0.6) {
    type = SignalType.Buy;
    reason = `Bull regime (${(regime.confidence * 100).toFixed(0)}% confidence), RSI ${rsi.toFixed(1)} not overbought`;
  } else if (regime.regime === MarketRegime.Bear && rsi > RSI_OVERSOLD && regime.confidence > 0.6) {
    type = SignalType.Sell;
    reason = `Bear regime (${(regime.confidence * 100).toFixed(0)}% confidence), RSI ${rsi.toFixed(1)} not oversold`;
  } else if (regime.confidence < 0.6) {
    reason = `Low regime confidence (${(regime.confidence * 100).toFixed(0)}%) — holding`;
  }

  return {
    asset,
    pair,
    type,
    regime: regime.regime,
    rsi,
    price: latestClose,
    timestamp: Date.now(),
    reason,
  };
}
