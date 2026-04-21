// ─── Candle / Market Data ────────────────────────────────────────────────────

export interface Candle {
  timestamp: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Asset = string; // e.g. "BTC", "ETH"
export type QuoteAsset = string; // e.g. "AUD"
export type TradingPair = `${Asset}/${QuoteAsset}`; // e.g. "BTC/AUD"

// ─── HMM / Regime ────────────────────────────────────────────────────────────

export enum MarketRegime {
  Bull = "Bull",
  Bear = "Bear",
  Sideways = "Sideways",
}

export interface RegimeState {
  regime: MarketRegime;
  probabilities: Record<MarketRegime, number>;
  confidence: number; // max probability
  updatedAt: number;
}

export interface HMMModelState {
  asset: Asset;
  trained: boolean;
  trainedAt: number | null;
  numObservations: number;
}

// ─── Signals ─────────────────────────────────────────────────────────────────

export enum SignalType {
  Buy = "Buy",
  Sell = "Sell",
  Hold = "Hold",
}

export interface TradeSignal {
  asset: Asset;
  pair: TradingPair;
  type: SignalType;
  regime: MarketRegime;
  rsi: number;
  price: number;
  timestamp: number;
  reason: string;
}

// ─── Orders / Positions ───────────────────────────────────────────────────────

export enum OrderSide {
  Buy = "buy",
  Sell = "sell",
}

export enum OrderType {
  Market = "market",
  Limit = "limit",
}

export enum OrderStatus {
  Pending = "pending",
  Filled = "filled",
  Cancelled = "cancelled",
  Rejected = "rejected",
}

export interface Order {
  id: string;
  asset: Asset;
  pair: TradingPair;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price: number;
  status: OrderStatus;
  paperId?: string; // set in paper mode
  createdAt: number;
  filledAt?: number;
}

export interface Position {
  asset: Asset;
  pair: TradingPair;
  side: OrderSide;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfit: number;
  unrealisedPnl: number;
  unrealisedPnlPct: number;
  openedAt: number;
}

// ─── Portfolio ────────────────────────────────────────────────────────────────

export interface PaperPortfolio {
  startingAUD: number;
  cashAUD: number;
  positions: Position[];
  realisedPnlAUD: number;
  unrealisedPnlAUD: number;
  totalValueAUD: number;
}

export interface Portfolio {
  totalValueAUD: number;
  cashAUD: number;
  positions: Position[];
  realisedPnlAUD: number;
  unrealisedPnlAUD: number;
  peakValueAUD: number;
  updatedAt: number;
  paper?: PaperPortfolio; // populated when paperMode=true
}

// ─── Risk Metrics ─────────────────────────────────────────────────────────────

export interface RiskMetrics {
  dailyPnlAUD: number;
  dailyPnlPct: number;
  drawdownFromPeakPct: number;
  isHalted: boolean;
  haltReason: string | null;
  dailyLossLimitPct: number;
  maxDrawdownPct: number;
}

// ─── WebSocket Messages ───────────────────────────────────────────────────────

export enum WSMessageType {
  // Server → Client
  Snapshot = "snapshot",
  CandleUpdate = "candle_update",
  RegimeUpdate = "regime_update",
  SignalUpdate = "signal_update",
  OrderUpdate = "order_update",
  PortfolioUpdate = "portfolio_update",
  RiskUpdate = "risk_update",
  ModeChange = "mode_change",
  // Client → Server
  SetMode = "set_mode",
  Subscribe = "subscribe",
}

export interface WSMessage<T = unknown> {
  type: WSMessageType;
  payload: T;
  timestamp: number;
}

export interface SnapshotPayload {
  paperMode: boolean;
  assets: Asset[];
  portfolio: Portfolio;
  riskMetrics: RiskMetrics;
  regimes: Record<Asset, RegimeState>;
  regimeSequences: Record<Asset, MarketRegime[]>;
  candles: Record<Asset, Candle[]>;
  latestCandles: Record<Asset, Candle>;
  recentTrades: Order[];
}

export interface CandleUpdatePayload {
  asset: Asset;
  candle: Candle;
}

export interface RegimeUpdatePayload {
  asset: Asset;
  regime: RegimeState;
}

export interface SignalUpdatePayload {
  signal: TradeSignal;
}

export interface OrderUpdatePayload {
  order: Order;
}

export interface PortfolioUpdatePayload {
  portfolio: Portfolio;
}

export interface RiskUpdatePayload {
  riskMetrics: RiskMetrics;
}

export interface ModeChangePayload {
  paperMode: boolean;
}

export interface SetModePayload {
  paperMode: boolean;
}
