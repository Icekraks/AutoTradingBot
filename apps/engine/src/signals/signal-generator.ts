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
  slowRegime: RegimeState;
}

export function generateSignal(ctx: SignalContext): TradeSignal {
  const { asset, quoteAsset, candles, regime, slowRegime } = ctx;
  const pair: TradingPair = `${asset}/${quoteAsset}`;
  const latestClose = candles[candles.length - 1].close;
  const closes = candles.map((c) => c.close);
  const rsi = calculateRSI(closes);

  let type = SignalType.Hold;
  let reason = `Fast: ${regime.regime}, Slow: ${slowRegime.regime}, RSI: ${rsi.toFixed(1)}`;

  // Entry: fast 15min drives timing; slow 1h must not be actively Bear (opposing)
  // Exit: slow 1h turning Bear is the primary exit — wait for the major trend to confirm reversal
  const slowActiveBear = slowRegime.regime === MarketRegime.Bear && slowRegime.confidence > 0.6;
  const slowActiveBull = slowRegime.regime === MarketRegime.Bull && slowRegime.confidence > 0.6;

  if (slowActiveBear) {
    type = SignalType.Sell;
    reason = `1h Bear (${(slowRegime.confidence * 100).toFixed(0)}%) — major trend exit, RSI ${rsi.toFixed(1)}`;
  } else if (regime.regime === MarketRegime.Bull && rsi < RSI_OVERBOUGHT && regime.confidence > 0.6 && !slowActiveBear) {
    type = SignalType.Buy;
    reason = `15m Bull (${(regime.confidence * 100).toFixed(0)}%), 1h=${slowRegime.regime}, RSI ${rsi.toFixed(1)}`;
  } else if (regime.regime === MarketRegime.Bear && rsi > RSI_OVERSOLD && regime.confidence > 0.6 && !slowActiveBull) {
    type = SignalType.Sell;
    reason = `15m Bear (${(regime.confidence * 100).toFixed(0)}%), 1h=${slowRegime.regime}, RSI ${rsi.toFixed(1)}`;
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
