import type { Asset, Candle, RegimeState, Order, Portfolio, RiskMetrics } from "@trading-bot/shared";

export type EngineEvent =
  | { type: "candle"; asset: Asset; candle: Candle }
  | { type: "regime"; asset: Asset; regime: RegimeState; slowRegime: RegimeState }
  | { type: "order"; order: Order }
  | { type: "portfolio"; portfolio: Portfolio }
  | { type: "risk"; metrics: RiskMetrics; brokerMetrics?: { name: string; metrics: RiskMetrics }[] }
  | { type: "mode"; broker: string; paperMode: boolean };

export type EngineEventHandler = (event: EngineEvent) => void;
