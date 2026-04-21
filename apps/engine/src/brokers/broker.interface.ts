import type { Asset, Candle, Order, OrderSide, OrderType, Portfolio } from "@trading-bot/shared";

export interface PlaceOrderParams {
  asset: Asset;
  quoteAsset: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limitPrice?: number;
}

export interface IBroker {
  /** Authenticate and initialise the connection */
  connect(): Promise<void>;

  /** Fetch OHLCV candles for an asset */
  getCandles(
    asset: Asset,
    quoteAsset: string,
    resolutionMinutes: number,
    count: number
  ): Promise<Candle[]>;

  /** Fetch the latest spot price */
  getPrice(asset: Asset, quoteAsset: string): Promise<number>;

  /** Fetch current portfolio balances */
  getPortfolio(): Promise<Portfolio>;

  /** Place an order — no-ops (logs only) in paper mode */
  placeOrder(params: PlaceOrderParams): Promise<Order>;

  /** Cancel an open order */
  cancelOrder(orderId: string): Promise<void>;

  /** Subscribe to live price ticks via callback */
  subscribeTicks(
    asset: Asset,
    quoteAsset: string,
    callback: (price: number, timestamp: number) => void
  ): Promise<() => void>; // returns unsubscribe fn

  disconnect(): Promise<void>;
}
