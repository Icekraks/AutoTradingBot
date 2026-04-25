"use client";

import type { Order } from "@trading-bot/shared";
import { OrderSide } from "@trading-bot/shared";
import { cn, formatCurrency, formatTimestamp } from "@/lib/utils";

interface TradeLogProps {
  trades: Order[];
}

export function TradeLog({ trades }: TradeLogProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 flex flex-col h-auto">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <span className="text-xs font-medium text-muted-foreground">
          Trade Log
        </span>
        <span className="text-xs text-muted-foreground">
          {trades.length} trades
        </span>
      </div>

      {trades.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">
          No trades yet
        </p>
      ) : (
        <div className="flex flex-col gap-1 overflow-y-auto">
          {trades.map((order) => {
            const isBuy = order.side === OrderSide.Buy;
            return (
              <div
                key={order.id}
                className="flex items-center gap-2 py-1.5 border-b border-border/50 last:border-0 text-xs"
              >
                <span
                  className={cn(
                    "w-10 text-center rounded px-1 font-medium shrink-0",
                    isBuy
                      ? "bg-green-950 text-green-400"
                      : "bg-red-950 text-red-400",
                  )}
                >
                  {isBuy ? "BUY" : "SELL"}
                </span>
                <span className="font-medium">{order.asset}</span>
                <span className="text-muted-foreground flex-1">
                  {order.quantity.toFixed(6)}
                </span>
                <span className="text-muted-foreground shrink-0">
                  {order.price > 0 ? formatCurrency(order.price) : "mkt"}
                </span>
                <span className="text-muted-foreground shrink-0">
                  {formatTimestamp(order.createdAt)}
                </span>
                {order.paperId && (
                  <span className="text-blue-400/60 text-xs shrink-0">
                    paper
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
