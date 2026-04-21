"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Activity, Wifi, WifiOff } from "lucide-react";
import type { Portfolio } from "@trading-bot/shared";
import { formatCurrency, formatPct } from "@/lib/utils";

interface HeaderProps {
  portfolio: Portfolio;
  paperMode: boolean;
  connected: boolean;
  onToggleMode: (paperMode: boolean) => void;
}

export function Header({
  portfolio,
  paperMode,
  connected,
  onToggleMode,
}: HeaderProps) {
  const [pendingMode, setPendingMode] = useState<boolean | null>(null);
  const paper = portfolio.paper;
  const paperPnl = paper ? paper.realisedPnlAUD + paper.unrealisedPnlAUD : 0;
  const paperPnlPct =
    paper && paper.startingAUD > 0 ? (paperPnl / paper.startingAUD) * 100 : 0;
  const paperPositive = paperPnl >= 0;

  const isConfirmOpen = pendingMode !== null;

  useEffect(() => {
    if (!isConfirmOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPendingMode(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isConfirmOpen]);

  const handleModeToggleRequest = (nextMode: boolean) => {
    if (nextMode === paperMode) return;
    setPendingMode(nextMode);
  };

  const handleConfirmToggle = () => {
    if (pendingMode === null) return;
    onToggleMode(pendingMode);
    setPendingMode(null);
  };

  const modeLabel = pendingMode ? "PAPER" : "LIVE";
  const confirmationText = pendingMode
    ? "Switch to paper mode? Orders will be simulated and no live trades will be sent."
    : "Switch to live mode? New signals may place real orders on your exchange account.";

  return (
    <>
      <header className="flex items-center gap-6 px-4 h-14 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-2 text-primary font-semibold text-sm">
          <Activity size={16} />
          AutoTrader
        </div>

        {/* Real account balance */}
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs text-muted-foreground">Real</span>
          <span className="text-lg font-bold">
            {formatCurrency(portfolio.totalValueAUD)}
          </span>
        </div>

        {/* Paper portfolio — shown when paper mode is active and tracker has data */}
        {paperMode && paper && (
          <>
            <div className="w-px h-5 bg-border" />
            <div className="flex items-baseline gap-1.5">
              <span className="text-xs text-blue-400 font-medium">Paper</span>
              <span className="text-lg font-bold">
                {formatCurrency(paper.totalValueAUD)}
              </span>
              <span
                className={`text-xs font-medium ${
                  paperPositive ? "text-green-400" : "text-red-400"
                }`}
              >
                {paperPositive ? "+" : ""}
                {formatPct(paperPnlPct)} ({paperPositive ? "+" : ""}
                {formatCurrency(paperPnl)})
              </span>
            </div>
          </>
        )}

        <div className="flex-1" />

        <div
          className={`flex items-center gap-1.5 text-xs ${
            connected ? "text-green-400" : "text-red-400"
          }`}
        >
          {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
          {connected ? "Live" : "Disconnected"}
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span
            className={
              paperMode ? "text-muted-foreground" : "text-red-400 font-semibold"
            }
          >
            LIVE
          </span>
          <Switch
            checked={paperMode}
            onCheckedChange={handleModeToggleRequest}
          />
          <span
            className={
              paperMode
                ? "text-blue-400 font-semibold"
                : "text-muted-foreground"
            }
          >
            PAPER
          </span>
        </div>
      </header>

      {isConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-2xl">
            <h2 className="text-sm font-semibold text-foreground">
              Confirm mode switch to {modeLabel}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {confirmationText}
            </p>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingMode(null)}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmToggle}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  pendingMode
                    ? "bg-primary text-primary-foreground hover:opacity-90"
                    : "bg-red-500 text-white hover:bg-red-400"
                }`}
              >
                Confirm switch
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
