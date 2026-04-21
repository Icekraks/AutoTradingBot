import "dotenv/config";
import { SwyftxBroker } from "./brokers/swyftx.broker.js";
import { TradingEngine } from "./engine/trading-engine.js";
import { startWSServer } from "./server/ws-server.js";
import { config } from "./config.js";

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Auto Trading Bot — starting up");
  console.log(`  Mode: ${config.trading.paperMode ? "PAPER 📄" : "LIVE 🔴"}`);
  console.log(`  Assets: ${config.trading.assets.map((a) => `${a}/${config.trading.quoteAsset}`).join(", ")}`);
  console.log(`  Candle resolution: ${config.hmm.candleResolutionMinutes}min`);
  console.log("═══════════════════════════════════════");

  const broker = new SwyftxBroker(config.trading.paperMode);
  const engine = new TradingEngine(broker);

  const server = startWSServer(engine);

  await engine.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[Main] ${signal} received — shutting down`);
    await engine.stop();
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[Main] Fatal error:", err);
  process.exit(1);
});
