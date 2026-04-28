import type { Asset, Candle, RegimeState } from "@trading-bot/shared";

export interface SignalContext {
  asset: Asset;
  quoteAsset: string;
  candles: Candle[];
  regime: RegimeState;
  slowRegime: RegimeState;
}
