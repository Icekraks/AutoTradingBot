"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickSeriesOptions,
  type CandlestickData,
  type SeriesMarker,
  type Time,
  ColorType,
} from "lightweight-charts";
import type { Asset, Candle } from "@trading-bot/shared";
import { MarketRegime } from "@trading-bot/shared";

const QUOTE_ASSET = process.env.NEXT_PUBLIC_QUOTE_ASSET ?? "AUD";
const FREQUENCY = process.env.NEXT_PUBLIC_FREQUENCY ?? "15m";

// How many hours to show on initial load / asset switch
const DEFAULT_VISIBLE_HOURS = 24;

interface PriceChartProps {
  asset: Asset;
  candles: Candle[];
  regimes: MarketRegime[];
}

const TZ = "Australia/Sydney";

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-AU", { month: "short", day: "numeric", timeZone: TZ });
}

function aestParts(ts: number): { h: number; m: number; date: number; month: number } {
  const d = new Date(ts * 1000);
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: TZ,
    hour: "numeric", minute: "numeric", day: "numeric", month: "numeric",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  return { h: get("hour"), m: get("minute"), date: get("day"), month: get("month") };
}

// lightweight-charts calls tickMarkFormatter with the unix-second timestamp as a plain number
function tickFormatter(time: Time): string {
  if (typeof time !== "number") return "";
  const { h, m } = aestParts(time);
  // Show date label at midnight AEST, time label otherwise
  if (h === 0 && m === 0) return fmtDate(time);
  // Show HH:MM only on the hour or half-hour so labels don't overlap
  if (m === 0 || m === 30) return fmtTime(time);
  return "";
}

export function PriceChart({ asset, candles, regimes }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastAssetRef = useRef<Asset | null>(null);

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
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: tickFormatter,
      },
      localization: {
        locale: "en-AU",
        timeFormatter: (time: Time) =>
          typeof time === "number" ? `${fmtDate(time)}  ${fmtTime(time)}` : "",
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
      time: Math.floor(c.timestamp / 1000) as unknown as CandlestickData["time"],
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      ...(regimes[i]
        ? {
            color:
              regimes[i] === MarketRegime.Bull ? "#4ade80"
              : regimes[i] === MarketRegime.Bear ? "#f87171"
              : "#9ca3af",
          }
        : {}),
    }));

    seriesRef.current.setData(data);

    // Day-boundary markers keyed on AEST date so midnight aligns with Sydney timezone
    const markers: SeriesMarker<Time>[] = [];
    for (let i = 1; i < candles.length; i++) {
      const prev = aestParts(Math.floor(candles[i - 1].timestamp / 1000));
      const curr = aestParts(Math.floor(candles[i].timestamp / 1000));
      if (prev.date !== curr.date || prev.month !== curr.month) {
        markers.push({
          time: Math.floor(candles[i].timestamp / 1000) as Time,
          position: "belowBar",
          color: "#475569",
          shape: "arrowUp",
          text: fmtDate(Math.floor(candles[i].timestamp / 1000)),
          size: 0,
        });
      }
    }
    seriesRef.current.setMarkers(markers);

    // On initial load or asset switch, reset to last DEFAULT_VISIBLE_HOURS.
    // Deferred via rAF so setData's internal viewport update doesn't clobber it.
    // User's manual scroll/zoom is preserved between candle updates for the same asset.
    if (lastAssetRef.current !== asset) {
      lastAssetRef.current = asset;
      requestAnimationFrame(() => {
        const nowSec = Math.floor(Date.now() / 1000);
        try {
          chartRef.current?.timeScale().setVisibleRange({
            from: (nowSec - DEFAULT_VISIBLE_HOURS * 3600) as Time,
            to: nowSec as Time,
          });
        } catch {
          chartRef.current?.timeScale().fitContent();
        }
      });
    }
  }, [candles, regimes, asset]);

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
