"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type {
  Asset,
  BrokerRiskMetrics,
  Candle,
  Order,
  Portfolio,
  RegimeState,
  RiskMetrics,
  SnapshotPayload,
  WSMessage,
} from "@trading-bot/shared";
import { WSMessageType, MarketRegime } from "@trading-bot/shared";

export interface TradingState {
  paperMode: boolean;
  assets: Asset[];
  portfolio: Portfolio;
  riskMetrics: RiskMetrics;
  brokerMetrics?: BrokerRiskMetrics[];
  regimes: Record<Asset, RegimeState>;
  regimeSequences: Record<Asset, MarketRegime[]>;
  candles: Record<Asset, Candle[]>;
  latestCandles: Record<Asset, Candle>;
  recentTrades: Order[];
}

const MAX_CANDLE_HISTORY = 300;

export function useTradingSocket(wsUrl: string) {
  const [state, setState] = useState<TradingState | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as WSMessage;
        handleMessage(msg);
      } catch {}
    };
  }, [wsUrl]);

  function handleMessage(msg: WSMessage) {
    switch (msg.type) {
      case WSMessageType.Snapshot: {
        const snap = msg.payload as SnapshotPayload;
        setState({
          paperMode: snap.paperMode,
          assets: snap.assets,
          portfolio: snap.portfolio,
          riskMetrics: snap.riskMetrics,
          brokerMetrics: snap.brokerMetrics,
          regimes: snap.regimes,
          regimeSequences: (snap.regimeSequences ?? {}) as Record<Asset, MarketRegime[]>,
          candles: Object.fromEntries(
            snap.assets.map((a) => [a, (snap.candles?.[a] ?? (snap.latestCandles[a] ? [snap.latestCandles[a]] : [])).slice(-MAX_CANDLE_HISTORY)])
          ) as Record<Asset, Candle[]>,
          latestCandles: snap.latestCandles,
          recentTrades: snap.recentTrades,
        });
        break;
      }

      case WSMessageType.CandleUpdate: {
        const { asset, candle } = msg.payload as { asset: Asset; candle: Candle };
        setState((prev) => {
          if (!prev) return prev;
          const existing = prev.candles[asset] ?? [];
          const last = existing[existing.length - 1];
          const updated = (last?.timestamp === candle.timestamp
            ? [...existing.slice(0, -1), candle]
            : [...existing, candle]
          ).slice(-MAX_CANDLE_HISTORY);
          return {
            ...prev,
            candles: { ...prev.candles, [asset]: updated },
            latestCandles: { ...prev.latestCandles, [asset]: candle },
          };
        });
        break;
      }

      case WSMessageType.RegimeUpdate: {
        const { asset, regime } = msg.payload as { asset: Asset; regime: RegimeState };
        setState((prev) => {
          if (!prev) return prev;
          const seq = [...(prev.regimeSequences[asset] ?? []), regime.regime].slice(-MAX_CANDLE_HISTORY);
          return {
            ...prev,
            regimes: { ...prev.regimes, [asset]: regime },
            regimeSequences: { ...prev.regimeSequences, [asset]: seq },
          };
        });
        break;
      }

      case WSMessageType.PortfolioUpdate:
        setState((prev) => prev ? { ...prev, portfolio: (msg.payload as { portfolio: Portfolio }).portfolio } : prev);
        break;

      case WSMessageType.RiskUpdate: {
        const { riskMetrics, brokerMetrics } = msg.payload as { riskMetrics: RiskMetrics; brokerMetrics?: BrokerRiskMetrics[] };
        setState((prev) => prev ? { ...prev, riskMetrics, brokerMetrics } : prev);
        break;
      }

      case WSMessageType.OrderUpdate: {
        const { order } = msg.payload as { order: Order };
        setState((prev) => {
          if (!prev) return prev;
          const trades = [order, ...prev.recentTrades].slice(0, 50);
          return { ...prev, recentTrades: trades };
        });
        break;
      }

      case WSMessageType.ModeChange:
        setState((prev) => prev ? { ...prev, paperMode: (msg.payload as { paperMode: boolean }).paperMode } : prev);
        break;
    }
  }

  const setMode = useCallback((paperMode: boolean) => {
    wsRef.current?.send(
      JSON.stringify({ type: WSMessageType.SetMode, payload: { paperMode }, timestamp: Date.now() })
    );
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { state, connected, setMode };
}
