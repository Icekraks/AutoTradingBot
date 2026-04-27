"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Activity, Wifi, WifiOff } from "lucide-react";
import type { BrokerPortfolio, Portfolio } from "@trading-bot/shared";
import { formatCurrency, formatPct } from "@/lib/utils";

interface HeaderProps {
  portfolio: Portfolio;
  paperModes: Record<string, boolean>;
  connected: boolean;
  onToggleMode: (broker: string, paperMode: boolean) => void;
}

function BrokerStat({
  broker,
  paperMode,
  onToggle,
}: {
  broker: BrokerPortfolio;
  paperMode: boolean;
  onToggle: (next: boolean) => void;
}) {
  const paper = broker.paper;
  const paperPnl = paper ? paper.totalValue - paper.starting : 0;
  const paperPnlPct = paper && paper.starting > 0 ? (paperPnl / paper.starting) * 100 : 0;
  const paperPositive = paperPnl >= 0;

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-baseline gap-1.5">
        <span className="text-xs text-muted-foreground">{broker.name}</span>
        {paperMode && paper ? (
          <>
            <span className="text-base font-bold text-blue-400">
              {formatCurrency(paper.totalValue)}
            </span>
            <span className={`text-xs font-medium ${paperPositive ? "text-green-400" : "text-red-400"}`}>
              {formatPct(paperPnlPct)} ({paperPositive ? "+" : ""}{formatCurrency(paperPnl)})
            </span>
          </>
        ) : (
          <span className="text-base font-bold">{formatCurrency(broker.totalValue)}</span>
        )}
      </div>
      <div className="flex items-center gap-1 text-xs">
        <span className={paperMode ? "text-muted-foreground" : "text-red-400 font-semibold"}>LIVE</span>
        <Switch checked={paperMode} onCheckedChange={onToggle} />
        <span className={paperMode ? "text-blue-400 font-semibold" : "text-muted-foreground"}>PAPER</span>
      </div>
    </div>
  );
}

type Pending = { broker: string; paperMode: boolean };

export function Header({
  portfolio,
  paperModes,
  connected,
  onToggleMode,
}: HeaderProps) {
  const [pending, setPending] = useState<Pending | null>(null);

  const hasBrokers = portfolio.brokers && portfolio.brokers.length > 0;
  const paper = portfolio.paper;
  const paperPnl = paper ? Math.round(paper.totalValue * 100) / 100 - Math.round(paper.starting * 100) / 100 : 0;
  const paperPnlPct = paper && paper.starting > 0 ? (paperPnl / paper.starting) * 100 : 0;
  const paperPositive = paperPnl >= 0;
  const singlePaperMode = paperModes["Crypto"] ?? false;

  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setPending(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending]);

  const handleToggleRequest = (broker: string, nextPaperMode: boolean) => {
    const current = paperModes[broker] ?? false;
    if (nextPaperMode === current) return;
    setPending({ broker, paperMode: nextPaperMode });
  };

  const handleConfirm = () => {
    if (!pending) return;
    onToggleMode(pending.broker, pending.paperMode);
    setPending(null);
  };

  const modeLabel = pending?.paperMode ? "PAPER" : "LIVE";
  const confirmationText = pending?.paperMode
    ? `Switch ${pending.broker} to paper mode? Orders will be simulated.`
    : `Switch ${pending?.broker} to live mode? New signals may place real orders on your exchange account.`;

  return (
    <>
      <header className="flex items-center gap-6 px-4 h-14 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-2 text-primary font-semibold text-sm">
          <Activity size={16} />
          AutoTrader
        </div>

        {hasBrokers ? (
          <>
            {portfolio.brokers!.map((broker, i) => (
              <div key={broker.name} className="flex items-center gap-4">
                {i > 0 && <div className="w-px h-5 bg-border" />}
                <BrokerStat
                  broker={broker}
                  paperMode={paperModes[broker.name] ?? false}
                  onToggle={(next) => handleToggleRequest(broker.name, next)}
                />
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xs text-muted-foreground">Real</span>
              <span className="text-lg font-bold">{formatCurrency(portfolio.totalValue)}</span>
            </div>
            {singlePaperMode && paper && (
              <>
                <div className="w-px h-5 bg-border" />
                <div className="flex items-baseline gap-1.5">
                  <span className="text-xs text-blue-400 font-medium">Paper</span>
                  <span className="text-lg font-bold">{formatCurrency(paper.totalValue)}</span>
                  <span className={`text-xs font-medium ${paperPositive ? "text-green-400" : "text-red-400"}`}>
                    {formatPct(paperPnlPct)} ({paperPositive ? "+" : ""}{formatCurrency(paperPnl)})
                  </span>
                </div>
              </>
            )}
          </>
        )}

        <div className="flex-1" />

        <div className={`flex items-center gap-1.5 text-xs ${connected ? "text-green-400" : "text-red-400"}`}>
          {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
          {connected ? "Live" : "Disconnected"}
        </div>

        {!hasBrokers && (
          <div className="flex items-center gap-2 text-xs">
            <span className={singlePaperMode ? "text-muted-foreground" : "text-red-400 font-semibold"}>LIVE</span>
            <Switch checked={singlePaperMode} onCheckedChange={(v) => handleToggleRequest("Crypto", v)} />
            <span className={singlePaperMode ? "text-blue-400 font-semibold" : "text-muted-foreground"}>PAPER</span>
          </div>
        )}
      </header>

      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-2xl">
            <h2 className="text-sm font-semibold text-foreground">Confirm mode switch to {modeLabel}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{confirmationText}</p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPending(null)}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  pending.paperMode
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
