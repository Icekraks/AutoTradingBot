export interface AlpacaAccount {
  equity: string;
  cash: string;
  portfolio_value: string;
}

export interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface AlpacaBarsResponse {
  bars: AlpacaBar[];
  symbol: string;
  next_page_token: string | null;
}

export interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  unrealized_pl: string;
  unrealized_plpc: string;
}

export interface AlpacaLatestTrade {
  trade: { p: number; t: string };
}

export interface AlpacaOrderResponse {
  id: string;
  status: string;
  filled_avg_price: string | null;
}

export interface AlpacaWSMessage {
  T: string;
  msg?: string;
  S?: string;
  p?: number;
  t?: string;
}
