"use client";

import type { Position } from "@trading-bot/shared";
import { OrderSide } from "@trading-bot/shared";
import { cn, formatCurrency, formatPct } from "@/lib/utils";
import { TrendingUp, TrendingDown } from "lucide-react";

interface PositionsProps {
  positions: Position[];
}

export function Positions({ positions }: PositionsProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-muted-foreground">Open Positions</span>
        <span className="text-xs text-muted-foreground">{positions.length}</span>
      </div>

      {positions.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">No open positions</p>
      ) : (
        <div className="flex flex-col gap-2">
          {positions.map((pos) => {
            const isLong = pos.side === OrderSide.Buy;
            const pnlPositive = pos.unrealisedPnlPct >= 0;
            return (
              <div key={`${pos.asset}-${pos.openedAt}`} className="rounded-md border border-border p-2 text-xs">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5 font-medium">
                    {isLong ? (
                      <TrendingUp size={12} className="text-green-400" />
                    ) : (
                      <TrendingDown size={12} className="text-red-400" />
                    )}
                    {pos.pair}
                    <span className={cn("px-1 rounded text-xs", isLong ? "bg-green-950 text-green-400" : "bg-red-950 text-red-400")}>
                      {isLong ? "LONG" : "SHORT"}
                    </span>
                  </div>
                  <span className={cn("font-medium", pnlPositive ? "text-green-400" : "text-red-400")}>
                    {formatPct(pos.unrealisedPnlPct)}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-3 text-muted-foreground">
                  <span>Entry: {formatCurrency(pos.entryPrice)}</span>
                  <span>Now: {formatCurrency(pos.currentPrice)}</span>
                  <span>SL: {formatCurrency(pos.stopLoss)}</span>
                  <span>TP: {formatCurrency(pos.takeProfit)}</span>
                </div>
                <div className={cn("mt-1 font-medium", pnlPositive ? "text-green-400" : "text-red-400")}>
                  {formatCurrency(pos.unrealisedPnl)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
