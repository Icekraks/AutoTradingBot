// Each row: [time, open, high, low, close, vwap, volume, count]
export type KrakenOHLCRow = [number, string, string, string, string, string, string, number];

export interface KrakenOHLCResponse {
  error: string[];
  result: Record<string, KrakenOHLCRow[]>;
}

export interface SwyftxOrderResponse {
  orderUuid: string;
  processed: boolean;
}

export interface SwyftxTickerResponse {
  lastPrice: string;
}

export interface SwyftxBalance {
  assetId: number;
  availableBalance: string;
  stakingBalance: string;
}

export interface SwyftxAsset {
  id: number;
  code: string;
}

export interface KrakenWSTicker {
  channel: string;
  data: Array<{ symbol: string; last: number }>;
}
