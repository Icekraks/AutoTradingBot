import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const QUOTE_ASSET = process.env.NEXT_PUBLIC_QUOTE_ASSET ?? "AUD";
const LOCALE = QUOTE_ASSET === "AUD" ? "en-AU" : "en-US";

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency: QUOTE_ASSET,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** @deprecated use formatCurrency */
export const formatAUD = formatCurrency;

export function formatPct(value: number, showSign = true): string {
  const sign = showSign && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
