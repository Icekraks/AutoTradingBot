import type { Asset, OrderSide } from "@trading-bot/shared";
import { MarketRegime } from "@trading-bot/shared";

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
  pnl: number;
  pnlPct: number;
  entryTimestamp: number;
  exitTimestamp: number;
  entryRegime: MarketRegime;
}

export interface SimPosition {
  side: OrderSide;
  entryPrice: number;
  quantity: number;
  entryTimestamp: number;
  entryRegime: MarketRegime;
  stopLoss: number;
  takeProfit: number;
}
