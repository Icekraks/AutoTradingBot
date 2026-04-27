"use client";

import type { Portfolio, Position } from "@trading-bot/shared";
import { OrderSide } from "@trading-bot/shared";
import { cn, formatCurrency, formatPct } from "@/lib/utils";
import { TrendingUp, TrendingDown } from "lucide-react";

interface PositionsProps {
  portfolio: Portfolio;
  paperModes: Record<string, boolean>;
}

function PositionCard({ pos }: { pos: Position }) {
  const isLong = pos.side === OrderSide.Buy;
  const pnlPositive = pos.unrealisedPnlPct >= 0;
  return (
    <div className="rounded-md border border-border p-2 text-xs">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5 font-medium">
          {isLong ? <TrendingUp size={12} className="text-green-400" /> : <TrendingDown size={12} className="text-red-400" />}
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
}

function PositionGroup({ label, positions }: { label: string; positions: Position[] }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">{positions.length}</span>
      </div>
      {positions.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-2">No open positions</p>
      ) : (
        <div className="flex flex-col gap-2">
          {positions.map((pos) => <PositionCard key={`${pos.asset}-${pos.openedAt}`} pos={pos} />)}
        </div>
      )}
    </div>
  );
}

export function Positions({ portfolio, paperModes }: PositionsProps) {
  const hasBrokers = portfolio.brokers && portfolio.brokers.length > 0;

  if (hasBrokers) {
    return (
      <div className="rounded-lg border border-border bg-card p-3">
        <span className="text-xs font-medium text-muted-foreground">Open Positions</span>
        <div className="mt-3 flex flex-col gap-4">
          {portfolio.brokers!.map((broker, i) => {
            const positions = (paperModes[broker.name] ?? false) && broker.paper
              ? broker.paper.positions
              : broker.positions;
            return (
              <div key={broker.name}>
                {i > 0 && <div className="border-t border-border mb-4" />}
                <PositionGroup label={broker.name} positions={positions} />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Single broker fallback
  const anyPaper = Object.values(paperModes).some(Boolean);
  const positions = anyPaper && portfolio.paper ? portfolio.paper.positions : portfolio.positions;
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
          {positions.map((pos) => <PositionCard key={`${pos.asset}-${pos.openedAt}`} pos={pos} />)}
        </div>
      )}
    </div>
  );
}
