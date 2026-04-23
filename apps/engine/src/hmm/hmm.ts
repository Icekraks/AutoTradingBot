/**
 * Hidden Markov Model with multivariate Gaussian emissions.
 * Implemented in log-space throughout for numerical stability.
 *
 * Baum-Welch (EM) for training, Viterbi for regime decoding.
 */

export interface HMMParams {
  numStates: number;
  numFeatures: number;
  /** log initial state probabilities [numStates] */
  logPi: number[];
  /** log transition matrix [numStates][numStates] */
  logA: number[][];
  /** emission means [numStates][numFeatures] */
  means: number[][];
  /** emission variances [numStates][numFeatures] */
  variances: number[][];
}

export class HiddenMarkovModel {
  readonly numStates: number;
  readonly numFeatures: number;

  logPi: number[];
  logA: number[][];
  means: number[][];
  variances: number[][];

  constructor(numStates: number, numFeatures: number) {
    this.numStates = numStates;
    this.numFeatures = numFeatures;
    this.logPi = [];
    this.logA = [];
    this.means = [];
    this.variances = [];
    this.initializeParams();
  }

  private initializeParams(): void {
    const N = this.numStates;

    // Uniform initial distribution
    this.logPi = Array(N).fill(-Math.log(N));

    // Slight self-transition preference (0.8 self, 0.2 / (N-1) others)
    this.logA = [];
    for (let i = 0; i < N; i++) {
      const row = Array(N).fill(0.2 / (N - 1));
      row[i] = 0.8;
      const sum = row.reduce((a, b) => a + b, 0);
      this.logA.push(row.map((v) => Math.log(v / sum)));
    }

    // Spread means across plausible return range, unit variance
    this.means = [];
    this.variances = [];
    const spread = [-0.01, 0, 0.01]; // bear, sideways, bull log-return seed
    for (let i = 0; i < N; i++) {
      this.means.push(Array(this.numFeatures).fill(0).map((_, f) => (f === 0 ? spread[i] ?? 0 : 0)));
      this.variances.push(Array(this.numFeatures).fill(1));
    }
  }

  // ─── Core math helpers ───────────────────────────────────────────────────

  private logSumExp(values: number[]): number {
    const max = Math.max(...values);
    if (!isFinite(max)) return -Infinity;
    return max + Math.log(values.reduce((s, v) => s + Math.exp(v - max), 0));
  }

  private logGaussian(x: number, mean: number, variance: number): number {
    const diff = x - mean;
    return -0.5 * (Math.log(2 * Math.PI * variance) + (diff * diff) / variance);
  }

  private logEmission(state: number, obs: number[]): number {
    let logP = 0;
    for (let f = 0; f < this.numFeatures; f++) {
      logP += this.logGaussian(obs[f], this.means[state][f], this.variances[state][f]);
    }
    return logP;
  }

  // ─── Forward / Backward ──────────────────────────────────────────────────

  private forward(obs: number[][]): number[][] {
    const T = obs.length;
    const N = this.numStates;
    const logAlpha: number[][] = Array.from({ length: T }, () => Array(N).fill(-Infinity));

    for (let i = 0; i < N; i++) {
      logAlpha[0][i] = this.logPi[i] + this.logEmission(i, obs[0]);
    }
    for (let t = 1; t < T; t++) {
      for (let j = 0; j < N; j++) {
        const incoming = Array.from({ length: N }, (_, i) => logAlpha[t - 1][i] + this.logA[i][j]);
        logAlpha[t][j] = this.logSumExp(incoming) + this.logEmission(j, obs[t]);
      }
    }
    return logAlpha;
  }

  private backward(obs: number[][]): number[][] {
    const T = obs.length;
    const N = this.numStates;
    const logBeta: number[][] = Array.from({ length: T }, () => Array(N).fill(-Infinity));

    for (let i = 0; i < N; i++) logBeta[T - 1][i] = 0;

    for (let t = T - 2; t >= 0; t--) {
      for (let i = 0; i < N; i++) {
        const outgoing = Array.from(
          { length: N },
          (_, j) => this.logA[i][j] + this.logEmission(j, obs[t + 1]) + logBeta[t + 1][j]
        );
        logBeta[t][i] = this.logSumExp(outgoing);
      }
    }
    return logBeta;
  }

  // ─── Baum-Welch training ─────────────────────────────────────────────────

  train(obs: number[][], maxIter = 150, tolerance = 1e-5): void {
    // Reinitialize before each run so periodic retraining starts clean
    this.initializeParams();

    // Scale initial variances to observed data — prevents degenerate uniform emissions
    // when data variance (1e-5 for crypto log returns) << initial variance (1.0)
    for (let f = 0; f < this.numFeatures; f++) {
      const vals = obs.map((o) => o[f]);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const dataVar = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
      for (let i = 0; i < this.numStates; i++) {
        this.variances[i][f] = Math.max(dataVar * 2, 1e-8);
      }
    }

    let prevLogLikelihood = -Infinity;
    const T = obs.length;
    const N = this.numStates;

    for (let iter = 0; iter < maxIter; iter++) {
      const logAlpha = this.forward(obs);
      const logBeta = this.backward(obs);
      const logLikelihood = this.logSumExp(logAlpha[T - 1]);

      if (Math.abs(logLikelihood - prevLogLikelihood) < tolerance) break;
      prevLogLikelihood = logLikelihood;

      // γ_t(i) — state posterior
      const logGamma: number[][] = Array.from({ length: T }, (_, t) => {
        const raw = Array.from({ length: N }, (_, i) => logAlpha[t][i] + logBeta[t][i]);
        const norm = this.logSumExp(raw);
        return raw.map((v) => v - norm);
      });

      // ξ_t(i,j) — transition posterior
      const logXi: number[][][] = Array.from({ length: T - 1 }, (_, t) => {
        const raw = Array.from({ length: N }, (_, i) =>
          Array.from(
            { length: N },
            (_, j) =>
              logAlpha[t][i] +
              this.logA[i][j] +
              this.logEmission(j, obs[t + 1]) +
              logBeta[t + 1][j]
          )
        );
        const norm = this.logSumExp(raw.flat());
        return raw.map((row) => row.map((v) => v - norm));
      });

      // M-step: π
      for (let i = 0; i < N; i++) this.logPi[i] = logGamma[0][i];

      // M-step: A
      for (let i = 0; i < N; i++) {
        const logDenom = this.logSumExp(logGamma.slice(0, T - 1).map((g) => g[i]));
        for (let j = 0; j < N; j++) {
          this.logA[i][j] = this.logSumExp(logXi.map((xi) => xi[i][j])) - logDenom;
        }
      }

      // M-step: emission means and variances
      for (let i = 0; i < N; i++) {
        const weights = logGamma.map((g) => Math.exp(g[i]));
        const totalWeight = weights.reduce((a, b) => a + b, 0);

        for (let f = 0; f < this.numFeatures; f++) {
          const newMean = weights.reduce((s, w, t) => s + w * obs[t][f], 0) / totalWeight;
          const newVar =
            weights.reduce((s, w, t) => {
              const d = obs[t][f] - newMean;
              return s + w * d * d;
            }, 0) / totalWeight;

          this.means[i][f] = newMean;
          this.variances[i][f] = Math.max(newVar, 1e-6); // floor to prevent collapse
        }
      }
    }
  }

  // ─── Viterbi decoding ────────────────────────────────────────────────────

  decode(obs: number[][]): { states: number[]; logProb: number } {
    const T = obs.length;
    const N = this.numStates;
    const logDelta: number[][] = Array.from({ length: T }, () => Array(N).fill(-Infinity));
    const psi: number[][] = Array.from({ length: T }, () => Array(N).fill(0));

    for (let i = 0; i < N; i++) {
      logDelta[0][i] = this.logPi[i] + this.logEmission(i, obs[0]);
    }

    for (let t = 1; t < T; t++) {
      for (let j = 0; j < N; j++) {
        let best = -Infinity;
        let bestIdx = 0;
        for (let i = 0; i < N; i++) {
          const v = logDelta[t - 1][i] + this.logA[i][j];
          if (v > best) { best = v; bestIdx = i; }
        }
        logDelta[t][j] = best + this.logEmission(j, obs[t]);
        psi[t][j] = bestIdx;
      }
    }

    // Backtrack
    const states = Array(T).fill(0);
    let bestFinal = -Infinity;
    for (let i = 0; i < N; i++) {
      if (logDelta[T - 1][i] > bestFinal) { bestFinal = logDelta[T - 1][i]; states[T - 1] = i; }
    }
    for (let t = T - 2; t >= 0; t--) {
      states[t] = psi[t + 1][states[t + 1]];
    }

    return { states, logProb: bestFinal };
  }

  /** Real-time: forward-only state probability for the most recent observation */
  currentStateProbs(obs: number[][]): number[] {
    const logAlpha = this.forward(obs);
    const T = obs.length;
    const norm = this.logSumExp(logAlpha[T - 1]);
    return logAlpha[T - 1].map((v) => Math.exp(v - norm));
  }

  // ─── Serialisation ───────────────────────────────────────────────────────

  toJSON(): HMMParams {
    return {
      numStates: this.numStates,
      numFeatures: this.numFeatures,
      logPi: this.logPi,
      logA: this.logA,
      means: this.means,
      variances: this.variances,
    };
  }

  static fromJSON(params: HMMParams): HiddenMarkovModel {
    const hmm = new HiddenMarkovModel(params.numStates, params.numFeatures);
    hmm.logPi = params.logPi;
    hmm.logA = params.logA;
    hmm.means = params.means;
    hmm.variances = params.variances;
    return hmm;
  }
}
