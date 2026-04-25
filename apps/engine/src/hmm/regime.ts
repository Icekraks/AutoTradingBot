import type { Asset, Candle } from "@trading-bot/shared";
import { MarketRegime, type RegimeState } from "@trading-bot/shared";
import { HiddenMarkovModel } from "./hmm.js";

const NUM_STATES = 3;
const NUM_FEATURES = 3; // [log_return, price_range, log_volume_ratio]

/**
 * Extracts a 3-feature observation vector from each candle.
 * Requires at least 2 candles (uses previous close for return).
 */
export function extractFeatures(candles: Candle[]): number[][] {
  const obs: number[][] = [];
  const windowSize = 20;

  for (let i = 1; i < candles.length; i++) {
    const logReturn = Math.log(candles[i].close / candles[i - 1].close);
    const priceRange = (candles[i].high - candles[i].low) / candles[i].close;

    // Volume ratio vs rolling 20-bar average
    const windowStart = Math.max(0, i - windowSize);
    const windowCandles = candles.slice(windowStart, i);
    const avgVolume = windowCandles.reduce((s, c) => s + c.volume, 0) / windowCandles.length;
    const volumeRatio = avgVolume > 0 ? candles[i].volume / avgVolume : 1;

    obs.push([logReturn, priceRange, Math.log(Math.max(volumeRatio, 1e-10))]);
  }

  return obs;
}

/**
 * Maps raw HMM state indices (0,1,2) to semantic regime labels.
 * Labelling is done by ranking states on their mean log-return:
 * highest = Bull, middle = Sideways, lowest = Bear.
 */
function labelStates(hmm: HiddenMarkovModel): Record<number, MarketRegime> {
  const meanReturns = hmm.means.map((m) => m[0]); // feature 0 = log_return
  const sorted = [...meanReturns]
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v - b.v); // ascending

  return {
    [sorted[0].i]: MarketRegime.Bear,
    [sorted[1].i]: MarketRegime.Sideways,
    [sorted[2].i]: MarketRegime.Bull,
  };
}

export class RegimeDetector {
  private asset: Asset;
  private hmm: HiddenMarkovModel;
  private stateLabels: Record<number, MarketRegime> = {};
  private trained = false;
  private trainedAt: number | null = null;

  constructor(asset: Asset) {
    this.asset = asset;
    this.hmm = new HiddenMarkovModel(NUM_STATES, NUM_FEATURES);
  }

  get isTrained(): boolean {
    return this.trained;
  }

  get trainedTimestamp(): number | null {
    return this.trainedAt;
  }

  /** Train on a full history of candles. Should be called on startup and periodically. */
  train(candles: Candle[]): void {
    if (candles.length < 50) {
      throw new Error(`[RegimeDetector:${this.asset}] Need at least 50 candles to train, got ${candles.length}`);
    }

    const obs = extractFeatures(candles);
    this.hmm.train(obs);
    this.stateLabels = labelStates(this.hmm);
    this.trained = true;
    this.trainedAt = Date.now();
    console.log(`[RegimeDetector:${this.asset}] Trained on ${obs.length} observations`);
  }

  /** Decode the most likely regime sequence for a set of candles (Viterbi). */
  decodeSequence(candles: Candle[]): MarketRegime[] {
    this.assertTrained();
    const obs = extractFeatures(candles);
    const { states } = this.hmm.decode(obs);
    return states.map((s) => this.stateLabels[s] ?? MarketRegime.Sideways);
  }

  /** Get the current regime and state probabilities from the latest candles (forward algorithm). */
  currentRegime(candles: Candle[]): RegimeState {
    this.assertTrained();
    const obs = extractFeatures(candles);
    const probs = this.hmm.currentStateProbs(obs);

    const probsByRegime: Record<MarketRegime, number> = {
      [MarketRegime.Bull]: 0,
      [MarketRegime.Bear]: 0,
      [MarketRegime.Sideways]: 0,
    };

    for (let s = 0; s < NUM_STATES; s++) {
      const regime = this.stateLabels[s] ?? MarketRegime.Sideways;
      probsByRegime[regime] += probs[s];
    }

    const regime = (Object.entries(probsByRegime) as [MarketRegime, number][]).reduce(
      (best, [r, p]) => (p > best[1] ? [r, p] : best),
      [MarketRegime.Sideways, 0] as [MarketRegime, number]
    )[0];

    return {
      regime,
      probabilities: probsByRegime,
      confidence: Math.max(...Object.values(probsByRegime)),
      updatedAt: Date.now(),
    };
  }

  serialise(): object {
    return {
      asset: this.asset,
      trainedAt: this.trainedAt,
      stateLabels: this.stateLabels,
      hmm: this.hmm.toJSON(),
    };
  }

  restore(data: ReturnType<RegimeDetector["serialise"]> & Record<string, unknown>): void {
    this.hmm = HiddenMarkovModel.fromJSON(data.hmm as Parameters<typeof HiddenMarkovModel.fromJSON>[0]);
    this.stateLabels = data.stateLabels as Record<number, MarketRegime>;
    this.trainedAt = data.trainedAt as number | null;
    this.trained = true;
    console.log(`[RegimeDetector:${this.asset}] Restored from snapshot (trained at ${new Date(this.trainedAt ?? 0).toISOString()})`);
  }

  private assertTrained(): void {
    if (!this.trained) {
      throw new Error(`[RegimeDetector:${this.asset}] Not yet trained — call train() first`);
    }
  }
}
