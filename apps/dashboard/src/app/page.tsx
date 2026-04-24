"use client";

import { useState } from "react";
import { useTradingSocket } from "@/hooks/useTradingSocket";
import { Header } from "@/components/Header";
import { PriceChart } from "@/components/PriceChart";
import { RegimePanel } from "@/components/RegimePanel";
import { RiskGauges } from "@/components/RiskGauges";
import { Positions } from "@/components/Positions";
import { TradeLog } from "@/components/TradeLog";
import type { Asset } from "@trading-bot/shared";

const QUOTE_ASSET = process.env.NEXT_PUBLIC_QUOTE_ASSET ?? "AUD";

export default function Page() {
  const { state, connected, setMode } = useTradingSocket(
    process.env.NEXT_PUBLIC_ENGINE_WS_URL ?? "ws://localhost:3001",
  );

  const [selectedAsset, setSelectedAsset] = useState<Asset>("BTC");

  if (!state) {
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground text-sm">
        {connected ? "Loading data…" : "Connecting to engine…"}
      </div>
    );
  }

  const assets = state.assets ?? ["BTC", "ETH"];

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <Header
        portfolio={state.portfolio}
        paperMode={state.paperMode}
        connected={connected}
        onToggleMode={setMode}
      />

      {/* Asset tabs */}
      <div className="flex gap-1 px-4 pt-3 shrink-0">
        {assets.map((asset) => (
          <button
            key={asset}
            onClick={() => setSelectedAsset(asset)}
            className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
              selectedAsset === asset
                ? "bg-primary text-primary-foreground"
                : "bg-card text-muted-foreground hover:text-foreground border border-border"
            }`}
          >
            {asset}/{QUOTE_ASSET}
          </button>
        ))}
      </div>

      {/* Main layout */}
      <div className="flex flex-1 gap-3 p-4 overflow-hidden">
        {/* Left: chart + regime */}
        <div className="flex flex-col flex-1 gap-3 min-w-0 overflow-hidden">
          <PriceChart
            asset={selectedAsset}
            candles={state.candles?.[selectedAsset] ?? []}
            regimes={state.regimeSequences?.[selectedAsset] ?? []}
          />
          <RegimePanel
            asset={selectedAsset}
            regime={state.regimes?.[selectedAsset] ?? null}
          />
        </div>

        {/* Right sidebar */}
        <div className="flex flex-col gap-3 w-72 overflow-y-auto shrink-0 min-h-0">
          <RiskGauges metrics={state.riskMetrics} brokerMetrics={state.brokerMetrics} />
          <Positions portfolio={state.portfolio} paperMode={state.paperMode} />
          <TradeLog trades={state.recentTrades ?? []} />
        </div>
      </div>
    </div>
  );
}
