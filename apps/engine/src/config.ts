import { config as dotenvConfig } from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// Find .env: try cwd (turbo runs from apps/engine), then walk up two levels to repo root
const candidates = [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
];
const envPath = candidates.find(existsSync);
if (envPath) {
  dotenvConfig({ path: envPath });
} else {
  console.warn("[config] No .env file found — copy .env.example to .env at the repo root");
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function getEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  swyftx: {
    apiKey: requireEnv("SWYFTX_API_KEY"),
    baseUrl: getEnv("SWYFTX_BASE_URL", "https://api.swyftx.com.au"),
    demoUrl: getEnv("SWYFTX_DEMO_URL", "https://api.demo.swyftx.com.au"),
    wsUrl: getEnv("SWYFTX_WS_URL", "wss://streaming.swyftx.com.au"),
  },

  trading: {
    paperMode: getEnv("PAPER_MODE", "true") === "true",
    assets: getEnv("ASSETS", "BTC,ETH").split(",").map((a) => a.trim()),
    quoteAsset: getEnv("QUOTE_ASSET", "AUD"),
    paperStartingBalance: Number(getEnv("PAPER_STARTING_BALANCE", "1000")),
  },

  hmm: {
    candleResolutionMinutes: Number(getEnv("HMM_CANDLE_RESOLUTION", "15")),
    lookbackCandles: Number(getEnv("HMM_LOOKBACK_CANDLES", "500")),
    slowCandleResolutionMinutes: Number(getEnv("HMM_SLOW_CANDLE_RESOLUTION", "60")),
    slowLookbackCandles: Number(getEnv("HMM_SLOW_LOOKBACK_CANDLES", "500")),
    numStates: Number(getEnv("HMM_NUM_STATES", "3")),
    retrainIntervalHours: Number(getEnv("HMM_RETRAIN_INTERVAL_HOURS", "6")),
  },

  risk: {
    maxDailyLossPct: Number(getEnv("MAX_DAILY_LOSS_PCT", "2")),
    maxDrawdownPct: Number(getEnv("MAX_DRAWDOWN_PCT", "5")),
    maxPositionSizePct: Number(getEnv("MAX_POSITION_SIZE_PCT", "10")),
    stopLossPct: Number(getEnv("STOP_LOSS_PCT", "2")),
    takeProfitPct: Number(getEnv("TAKE_PROFIT_PCT", "4")),
    minHoldCandles: Number(getEnv("MIN_HOLD_CANDLES", "3")),
  },

  server: {
    wsPort: Number(getEnv("ENGINE_WS_PORT", "3001")),
    restPort: Number(getEnv("ENGINE_REST_PORT", "3002")),
  },
} as const;

export type Config = typeof config;
