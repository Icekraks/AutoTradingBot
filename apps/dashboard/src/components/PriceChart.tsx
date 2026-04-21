"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickSeriesOptions,
  type CandlestickData,
  type Time,
  ColorType,
} from "lightweight-charts";
import type { Asset, Candle } from "@trading-bot/shared";
import { MarketRegime } from "@trading-bot/shared";

const QUOTE_ASSET = process.env.NEXT_PUBLIC_QUOTE_ASSET ?? "AUD";
const FREQUENCY = process.env.NEXT_PUBLIC_FREQUENCY ?? "15m";

interface PriceChartProps {
  asset: Asset;
  candles: Candle[];
  regimes: MarketRegime[];
}

function formatLocalTimeLabel(time: Time): string {
  if (typeof time === "number") {
    return new Date(time * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  if (typeof time === "object" && "year" in time) {
    return new Date(time.year, time.month - 1, time.day).toLocaleDateString(
      [],
      {
        month: "short",
        day: "numeric",
      },
    );
  }

  return "";
}

export function PriceChart({ asset, candles, regimes }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0f172a" },
        textColor: "#64748b",
      },
      grid: {
        vertLines: { color: "#1e293b" },
        horzLines: { color: "#1e293b" },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: "#1e293b" },
      timeScale: {
        borderColor: "#1e293b",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time) => formatLocalTimeLabel(time),
      },
      localization: {
        locale: navigator.language,
        timeFormatter: (time: Time) => formatLocalTimeLabel(time),
      },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });

    const series = chart.addCandlestickSeries({
      upColor: "#4ade80",
      downColor: "#f87171",
      borderUpColor: "#4ade80",
      borderDownColor: "#f87171",
      wickUpColor: "#4ade80",
      wickDownColor: "#f87171",
    } as Partial<CandlestickSeriesOptions>);

    chartRef.current = chart;
    seriesRef.current = series;

    const observer = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return;

    const data: CandlestickData[] = candles.map((c, i) => ({
      time: Math.floor(
        c.timestamp / 1000,
      ) as unknown as CandlestickData["time"],
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      // Colour individual candles by regime if available
      ...(regimes[i]
        ? {
            color:
              regimes[i] === MarketRegime.Bull
                ? "#4ade80"
                : regimes[i] === MarketRegime.Bear
                ? "#f87171"
                : "#9ca3af",
          }
        : {}),
    }));

    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [candles, regimes]);

  return (
    <div className="flex flex-col flex-1 rounded-lg border border-border bg-card overflow-hidden min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground">
          {asset}/{QUOTE_ASSET} — {FREQUENCY}
        </span>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-green-400 inline-block" />{" "}
            Bull
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />{" "}
            Bear
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-gray-400 inline-block" />{" "}
            Sideways
          </span>
        </div>
      </div>
      <div ref={containerRef} className="flex-1" />
    </div>
  );
}
