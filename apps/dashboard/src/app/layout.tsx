import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AutoTrader Dashboard",
  description: "HMM-powered crypto trading bot",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-surface text-white">{children}</body>
    </html>
  );
}
