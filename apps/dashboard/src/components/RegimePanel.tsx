"use client";

import { Progress } from "@/components/ui/progress";
import type { RegimeState } from "@trading-bot/shared";
import { MarketRegime } from "@trading-bot/shared";
import type { Asset } from "@trading-bot/shared";
import { cn } from "@/lib/utils";

interface RegimePanelProps {
  asset: Asset;
  regime: RegimeState | null;
  slowRegime: RegimeState | null;
}

const REGIME_STYLES: Record<MarketRegime, { label: string; color: string; bar: string }> = {
  [MarketRegime.Bull]:     { label: "Bull",     color: "text-green-400", bar: "bg-green-500" },
  [MarketRegime.Bear]:     { label: "Bear",     color: "text-red-400",   bar: "bg-red-500"   },
  [MarketRegime.Sideways]: { label: "Sideways", color: "text-gray-400",  bar: "bg-gray-500"  },
};

function RegimeRows({ regime }: { regime: RegimeState }) {
  return (
    <div className="flex flex-col gap-2">
      {(Object.entries(regime.probabilities) as [MarketRegime, number][]).map(([r, prob]) => (
        <div key={r} className="flex items-center gap-2">
          <span className={cn("text-xs w-16 shrink-0", REGIME_STYLES[r].color)}>
            {REGIME_STYLES[r].label}
          </span>
          <Progress
            value={Math.round(prob * 100)}
            className="flex-1 h-1.5"
            indicatorClassName={REGIME_STYLES[r].bar}
          />
          <span className="text-xs text-muted-foreground w-10 text-right">
            {(prob * 100).toFixed(1)}%
          </span>
        </div>
      ))}
    </div>
  );
}

function RegimeLabel({ regime }: { regime: RegimeState }) {
  return (
    <span className={cn("text-sm font-bold", REGIME_STYLES[regime.regime].color)}>
      {regime.regime}
      <span className="text-xs text-muted-foreground ml-1 font-normal">
        {(regime.confidence * 100).toFixed(0)}%
      </span>
    </span>
  );
}

export function RegimePanel({ asset, regime, slowRegime }: RegimePanelProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 shrink-0">
      {/* Fast 15m */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">15m — {asset}</span>
        {regime ? <RegimeLabel regime={regime} /> : <span className="text-xs text-muted-foreground">Training…</span>}
      </div>
      {regime ? <RegimeRows regime={regime} /> : null}

      {/* Slow 1h */}
      <div className="flex items-center justify-between mt-3 mb-2">
        <span className="text-xs font-medium text-muted-foreground">1h — {asset}</span>
        {slowRegime ? <RegimeLabel regime={slowRegime} /> : <span className="text-xs text-muted-foreground">Training…</span>}
      </div>
      {slowRegime ? <RegimeRows regime={slowRegime} /> : null}
    </div>
  );
}
