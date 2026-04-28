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
