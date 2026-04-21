"use client";

import { Progress } from "@/components/ui/progress";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import type { RiskMetrics } from "@trading-bot/shared";
import { cn, formatPct } from "@/lib/utils";

interface RiskGaugesProps {
  metrics: RiskMetrics | null;
}

export function RiskGauges({ metrics }: RiskGaugesProps) {
  if (!metrics) return null;

  const dailyUsedPct = Math.min(
    Math.abs(metrics.dailyPnlPct) / metrics.dailyLossLimitPct,
    1
  );
  const drawdownUsedPct = Math.min(
    metrics.drawdownFromPeakPct / metrics.maxDrawdownPct,
    1
  );

  return (
    <div className="rounded-lg border border-border bg-card p-3 shrink-0">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-muted-foreground">Risk Guardrails</span>
        {metrics.isHalted ? (
          <span className="flex items-center gap-1 text-xs text-red-400 font-semibold">
            <AlertTriangle size={12} /> HALTED
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-green-400">
            <ShieldCheck size={12} /> Active
          </span>
        )}
      </div>

      {metrics.isHalted && (
        <p className="text-xs text-red-400 mb-3 bg-red-950/30 border border-red-800/40 rounded px-2 py-1">
          {metrics.haltReason}
        </p>
      )}

      <div className="flex flex-col gap-3">
        <Gauge
          label="Daily P&L"
          value={formatPct(metrics.dailyPnlPct)}
          usedPct={dailyUsedPct}
          limitLabel={`Limit: ${metrics.dailyLossLimitPct}%`}
          danger={metrics.dailyPnlPct < 0}
        />
        <Gauge
          label="Drawdown"
          value={formatPct(metrics.drawdownFromPeakPct, false)}
          usedPct={drawdownUsedPct}
          limitLabel={`Max: ${metrics.maxDrawdownPct}%`}
          danger={drawdownUsedPct > 0.7}
        />
      </div>
    </div>
  );
}

function Gauge({
  label,
  value,
  usedPct,
  limitLabel,
  danger,
}: {
  label: string;
  value: string;
  usedPct: number;
  limitLabel: string;
  danger: boolean;
}) {
  const indicatorClassName =
    usedPct > 0.9 ? "bg-red-500" : usedPct > 0.6 ? "bg-yellow-500" : "bg-blue-500";

  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("font-medium", danger ? "text-red-400" : "text-foreground")}>{value}</span>
      </div>
      <Progress
        value={Math.round(usedPct * 100)}
        className="h-1.5"
        indicatorClassName={indicatorClassName}
      />
      <p className="text-xs text-muted-foreground mt-0.5 text-right">{limitLabel}</p>
    </div>
  );
}
