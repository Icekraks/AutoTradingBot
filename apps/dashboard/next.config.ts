import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), "../../.env") });

const nextConfig: NextConfig = {
  transpilePackages: ["@trading-bot/shared"],
  env: {
    NEXT_PUBLIC_QUOTE_ASSET: process.env.NEXT_PUBLIC_QUOTE_ASSET ?? "AUD",
    NEXT_PUBLIC_FREQUENCY: process.env.NEXT_PUBLIC_FREQUENCY ?? "15m",
  },
};

export default nextConfig;
