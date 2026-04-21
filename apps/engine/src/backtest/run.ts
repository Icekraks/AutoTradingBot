/**
 * Run backtests for all configured assets.
 * Usage: npm run backtest (from apps/engine)
 *
 * Reads historical candles from the broker and prints a performance summary.
 */
import "dotenv/config";
import { SwyftxBroker } from "../brokers/swyftx.broker.js";
import { Backtester } from "./backtester.js";
import { config } from "../config.js";

async function main() {
  const broker = new SwyftxBroker(true); // always paper for backtest
  await broker.connect();

  const backtester = new Backtester();

  for (const asset of config.trading.assets) {
    console.log(`\n── Backtesting ${asset}/${config.trading.quoteAsset} ──`);

    const candles = await broker.getCandles(
      asset,
      config.trading.quoteAsset,
      config.hmm.candleResolutionMinutes,
      1500 // ~31 days of 30min candles
    );

    const result = await backtester.run(asset, candles);

    console.log(`Total return:   ${result.totalReturnPct.toFixed(2)}% ($${result.totalReturn.toFixed(2)} AUD)`);
    console.log(`Sharpe ratio:   ${result.sharpeRatio.toFixed(3)}`);
    console.log(`Max drawdown:   ${result.maxDrawdownPct.toFixed(2)}%`);
    console.log(`Trades:         ${result.numTrades}`);
    console.log(`Win rate:       ${result.winRate.toFixed(1)}%`);
  }

  await broker.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
