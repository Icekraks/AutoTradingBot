import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Asset, Candle, Order, PaperPortfolio, Portfolio, RegimeState, MarketRegime, RiskMetrics } from "@trading-bot/shared";
import { OrderSide, OrderStatus, OrderType } from "@trading-bot/shared";
import type { IBroker } from "../brokers/broker.interface.js";
import { RegimeDetector } from "../hmm/regime.js";
import { generateSignal } from "../signals/signal-generator.js";
import { RiskManager } from "../guardrails/risk-manager.js";
import { PaperTracker } from "./paper-tracker.js";
import { ClaudeAnalytics } from "../analytics/claude-analytics.js";
import { config } from "../config.js";

const STATE_PATH = resolve(process.cwd(), "trading-state.json");

export type EngineEvent =
  | { type: "candle"; asset: Asset; candle: Candle }
  | { type: "regime"; asset: Asset; regime: RegimeState }
  | { type: "order"; order: Order }
  | { type: "portfolio"; portfolio: Portfolio }
  | { type: "risk"; metrics: RiskMetrics; brokerMetrics?: { name: string; metrics: RiskMetrics }[] }
  | { type: "mode"; paperMode: boolean };

export type EngineEventHandler = (event: EngineEvent) => void;

export class TradingEngine {
  private broker: IBroker;
  private assets: Asset[];
  private quoteAsset: string;
  private paperMode: boolean;
  private alpacaAssets: Set<Asset>;

  private detectors: Map<Asset, RegimeDetector> = new Map();
  private slowDetectors: Map<Asset, RegimeDetector> = new Map();
  private candleBuffers: Map<Asset, Candle[]> = new Map();
  private slowCandleBuffers: Map<Asset, Candle[]> = new Map();
  private recentTrades: Order[] = [];
  private cryptoPaperTracker: PaperTracker = new PaperTracker(0, "Crypto");
  private stocksPaperTracker: PaperTracker = new PaperTracker(0, "Stocks");
  private cryptoPeak = 0;
  private stocksPeak = 0;
  private tickUnsubscribers: Map<Asset, () => void> = new Map();

  private portfolio: Portfolio = {
    totalValueAUD: 0,
    cashAUD: 0,
    positions: [],
    realisedPnlAUD: 0,
    unrealisedPnlAUD: 0,
    peakValueAUD: 0,
    updatedAt: Date.now(),
  };

  private cryptoRiskManager: RiskManager;
  private stocksRiskManager: RiskManager | null = null;
  private claude: ClaudeAnalytics = new ClaudeAnalytics();
  private latestRegimes: Map<Asset, { fast: RegimeState; slow: RegimeState }> = new Map();
  private tickCount = 0;
  private intervalHandle: NodeJS.Timeout | null = null;
  private listeners: EngineEventHandler[] = [];

  constructor(broker: IBroker) {
    this.broker = broker;
    this.assets = [...config.trading.assets, ...config.alpaca.assets];
    this.quoteAsset = config.trading.quoteAsset;
    this.paperMode = config.trading.paperMode;
    this.alpacaAssets = new Set(config.alpaca.assets);

    for (const asset of this.assets) {
      this.detectors.set(asset, new RegimeDetector(asset));
      this.slowDetectors.set(asset, new RegimeDetector(asset));
      this.candleBuffers.set(asset, []);
      this.slowCandleBuffers.set(asset, []);
    }

    this.cryptoRiskManager = new RiskManager(
      () => this.cryptoPortfolioForRisk(),
      this.paperMode ? () => this.cryptoPaperTracker.getPortfolio() : undefined,
    );

    if (this.alpacaAssets.size > 0) {
      this.stocksRiskManager = new RiskManager(
        () => this.stocksPortfolioForRisk(),
        this.paperMode ? () => this.stocksPaperTracker.getPortfolio() : undefined,
      );
    }
  }

  on(handler: EngineEventHandler): () => void {
    this.listeners.push(handler);
    return () => { this.listeners = this.listeners.filter((h) => h !== handler); };
  }

  private emit(event: EngineEvent): void {
    for (const h of this.listeners) h(event);
  }

  async start(): Promise<void> {
    await this.broker.connect();
    this.portfolio = await this.broker.getPortfolio();

    const cryptoBalance = this.portfolio.brokers?.find((b) => b.name === "Crypto")?.totalValue
      ?? (this.portfolio.totalValueAUD > 0 ? this.portfolio.totalValueAUD : config.trading.paperStartingBalance);
    const stocksBalance = this.portfolio.brokers?.find((b) => b.name === "Stocks")?.totalValue
      ?? config.alpaca.paperStartingBalance;

    this.cryptoPeak = cryptoBalance;
    this.stocksPeak = stocksBalance;
    this.cryptoRiskManager.reset(cryptoBalance);
    this.stocksRiskManager?.reset(stocksBalance);
    this.cryptoPaperTracker.reset(cryptoBalance);
    this.stocksPaperTracker.reset(stocksBalance);

    await this.initialise();
    this.loadState();
    await this.subscribeAllTicks();

    const msUntilNextCandle = this.msUntilNextCandle();
    console.log(`[Engine] First tick in ${Math.round(msUntilNextCandle / 1000)}s`);
    setTimeout(async () => {
      await this.tick();
      this.intervalHandle = setInterval(
        () => void this.tick(),
        config.hmm.candleResolutionMinutes * 60 * 1000
      );
    }, msUntilNextCandle);
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    for (const unsub of this.tickUnsubscribers.values()) unsub();
    this.tickUnsubscribers.clear();
    await this.broker.disconnect();
  }

  setMode(paperMode: boolean): void {
    this.paperMode = paperMode;
    console.log(`[Engine] Mode changed — paper=${paperMode}`);
    this.emit({ type: "mode", paperMode });
  }

  // ─── Per-broker helpers ───────────────────────────────────────────────────

  private paperTrackerFor(asset: Asset): PaperTracker {
    return this.alpacaAssets.has(asset) ? this.stocksPaperTracker : this.cryptoPaperTracker;
  }

  private riskManagerFor(asset: Asset): RiskManager {
    return (this.stocksRiskManager && this.alpacaAssets.has(asset))
      ? this.stocksRiskManager
      : this.cryptoRiskManager;
  }

  private cryptoPortfolioForRisk(): Portfolio {
    const paper = this.cryptoPaperTracker.getPortfolio();
    return {
      totalValueAUD: paper.totalValueAUD,
      cashAUD: paper.cashAUD,
      positions: paper.positions,
      realisedPnlAUD: paper.realisedPnlAUD,
      unrealisedPnlAUD: paper.unrealisedPnlAUD,
      peakValueAUD: this.cryptoPeak,
      updatedAt: Date.now(),
    };
  }

  private stocksPortfolioForRisk(): Portfolio {
    const paper = this.stocksPaperTracker.getPortfolio();
    return {
      totalValueAUD: paper.totalValueAUD,
      cashAUD: paper.cashAUD,
      positions: paper.positions,
      realisedPnlAUD: paper.realisedPnlAUD,
      unrealisedPnlAUD: paper.unrealisedPnlAUD,
      peakValueAUD: this.stocksPeak,
      updatedAt: Date.now(),
    };
  }

  private combinedPaperPortfolio(): PaperPortfolio {
    const c = this.cryptoPaperTracker.getPortfolio();
    const s = this.stocksPaperTracker.getPortfolio();
    return {
      startingAUD: c.startingAUD + s.startingAUD,
      cashAUD: c.cashAUD + s.cashAUD,
      positions: [...c.positions, ...s.positions],
      realisedPnlAUD: c.realisedPnlAUD + s.realisedPnlAUD,
      unrealisedPnlAUD: c.unrealisedPnlAUD + s.unrealisedPnlAUD,
      totalValueAUD: c.totalValueAUD + s.totalValueAUD,
    };
  }

  private updatePeaks(): void {
    const cryptoValue = this.cryptoPaperTracker.getPortfolio().totalValueAUD;
    if (cryptoValue > this.cryptoPeak) this.cryptoPeak = cryptoValue;

    const stocksValue = this.stocksPaperTracker.getPortfolio().totalValueAUD;
    if (stocksValue > this.stocksPeak) this.stocksPeak = stocksValue;

    // Combined portfolio peak for non-paper mode
    if (this.portfolio.totalValueAUD > this.portfolio.peakValueAUD) {
      this.portfolio.peakValueAUD = this.portfolio.totalValueAUD;
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  private async initialise(): Promise<void> {
    for (const asset of this.assets) {
      const [candles, slowCandles] = await Promise.all([
        this.broker.getCandles(asset, this.quoteAsset, config.hmm.candleResolutionMinutes, config.hmm.lookbackCandles),
        this.broker.getCandles(asset, this.quoteAsset, config.hmm.slowCandleResolutionMinutes, config.hmm.slowLookbackCandles),
      ]);

      this.candleBuffers.set(asset, candles);
      this.slowCandleBuffers.set(asset, slowCandles);

      if (candles.length >= 50) {
        this.detectors.get(asset)!.train(candles);
      } else {
        console.log(`[Engine] ${asset} — only ${candles.length} candles (market closed?), skipping initial train`);
      }
      if (slowCandles.length >= 50) {
        this.slowDetectors.get(asset)!.train(slowCandles);
      }

      console.log(`[Engine] Initialised ${asset} — fast: ${candles.length} candles, slow: ${slowCandles.length} candles`);
    }

    this.emitPortfolio();
  }

  private async tick(): Promise<void> {
    console.log(`[Engine] Tick @ ${new Date().toISOString()}`);

    this.portfolio = await this.broker.getPortfolio();
    this.updatePeaks();

    // Update each paper tracker with latest close prices for its assets
    const cryptoPrices: Record<Asset, number> = {};
    const stocksPrices: Record<Asset, number> = {};
    for (const asset of this.assets) {
      const buffer = this.candleBuffers.get(asset) ?? [];
      if (buffer.length > 0) {
        const price = buffer[buffer.length - 1].close;
        if (this.alpacaAssets.has(asset)) stocksPrices[asset] = price;
        else cryptoPrices[asset] = price;
      }
    }
    this.cryptoPaperTracker.updatePrices(cryptoPrices);
    this.stocksPaperTracker.updatePrices(stocksPrices);

    // Candle-based stop-loss/take-profit
    for (const asset of this.assets) {
      const buffer = this.candleBuffers.get(asset) ?? [];
      if (buffer.length === 0) continue;
      const latest = buffer[buffer.length - 1];
      const fillPrice = this.paperTrackerFor(asset).checkCandleTrigger(asset, latest.low, latest.high);
      if (fillPrice !== null) this.triggerPaperExit(asset, fillPrice);
    }

    this.emitPortfolio();
    this.emitRisk();

    for (const asset of this.assets) {
      await this.processAsset(asset);
    }

    // Hourly market summary (every 4 ticks on 15m candles)
    this.tickCount++;
    if (this.claude.enabled && this.tickCount % 4 === 0) {
      await this.claude.marketSummary(this.latestRegimes, this.combinedPaperPortfolio());
    }

    // Periodic retrain
    for (const asset of this.assets) {
      const detector = this.detectors.get(asset)!;
      const hoursSinceTrain = detector.trainedTimestamp
        ? (Date.now() - detector.trainedTimestamp) / 3_600_000
        : Infinity;

      const buf = this.candleBuffers.get(asset)!;
      const slowBuf = this.slowCandleBuffers.get(asset)!;
      if (hoursSinceTrain >= config.hmm.retrainIntervalHours && buf.length >= 50) {
        detector.train(buf);
        if (slowBuf.length >= 50) this.slowDetectors.get(asset)!.train(slowBuf);
      }
    }

    this.saveState();
  }

  private isUSMarketOpen(): boolean {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);
    const weekday = parts.find((p) => p.type === "weekday")?.value;
    if (weekday === "Sat" || weekday === "Sun") return false;
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    const minuteOfDay = hour * 60 + minute;
    return minuteOfDay >= 240 && minuteOfDay < 1200; // 04:00–20:00 ET (extended hours)
  }

  private async processAsset(asset: Asset): Promise<void> {
    if (this.alpacaAssets.has(asset) && !this.isUSMarketOpen()) {
      console.log(`[Engine] ${asset} — US market closed, skipping`);
      return;
    }

    const [candles, slowCandles] = await Promise.all([
      this.broker.getCandles(asset, this.quoteAsset, config.hmm.candleResolutionMinutes, config.hmm.lookbackCandles),
      this.broker.getCandles(asset, this.quoteAsset, config.hmm.slowCandleResolutionMinutes, config.hmm.slowLookbackCandles),
    ]);

    this.candleBuffers.set(asset, candles);
    this.slowCandleBuffers.set(asset, slowCandles);
    const latest = candles[candles.length - 1];
    this.emit({ type: "candle", asset, candle: latest });

    const detector = this.detectors.get(asset)!;
    const slowDetector = this.slowDetectors.get(asset)!;
    if (!detector.isTrained || !slowDetector.isTrained) return;

    const regime = detector.currentRegime(candles.slice(-config.hmm.regimeWindow));
    const slowRegime = slowDetector.currentRegime(slowCandles.slice(-config.hmm.slowRegimeWindow));
    this.latestRegimes.set(asset, { fast: regime, slow: slowRegime });
    this.emit({ type: "regime", asset, regime });

    const signal = generateSignal({
      asset,
      quoteAsset: this.quoteAsset,
      candles,
      regime,
      slowRegime,
    });

    console.log(`[Engine] ${asset} signal=${signal.type} regime=${regime.regime} rsi=${signal.rsi.toFixed(1)}`);

    const riskManager = this.riskManagerFor(asset);
    const decision = riskManager.evaluate(signal);
    if (!decision.approved || !decision.params) {
      console.log(`[Engine] ${asset} rejected: ${decision.reason}`);
      return;
    }

    // Claude validates Buy signals before execution
    if (signal.type === "Buy" && this.claude.enabled) {
      const paperPortfolio = this.paperTrackerFor(asset).getPortfolio();
      const validation = await this.claude.validateSignal(signal, slowRegime, this.latestRegimes, paperPortfolio);
      if (!validation.approved) {
        console.log(`[Engine] ${asset} Claude rejected: ${validation.reasoning}`);
        return;
      }
    }

    const order = await this.broker.placeOrder(decision.params);
    if (order.status === OrderStatus.Filled) {
      this.recentTrades.unshift(order);
      if (this.recentTrades.length > 50) this.recentTrades.pop();

      if (order.paperId) {
        this.paperTrackerFor(asset).onOrderFilled(order, latest.close);
        this.emitPortfolio();
      }

      this.emit({ type: "order", order });
    }

    this.emitRisk();
  }

  // ─── Emitters ────────────────────────────────────────────────────────────

  private emitPortfolio(): void {
    const combined = this.paperMode ? this.combinedPaperPortfolio() : undefined;
    const brokers = this.portfolio.brokers?.map((b) => ({
      ...b,
      paper: this.paperMode
        ? (b.name === "Stocks" ? this.stocksPaperTracker.getPortfolio() : this.cryptoPaperTracker.getPortfolio())
        : undefined,
    }));

    this.emit({
      type: "portfolio",
      portfolio: { ...this.portfolio, paper: combined, brokers },
    });
  }

  private emitRisk(): void {
    const cryptoMetrics = this.cryptoRiskManager.getMetrics();

    if (this.stocksRiskManager) {
      const stocksMetrics = this.stocksRiskManager.getMetrics();
      this.emit({
        type: "risk",
        metrics: cryptoMetrics,
        brokerMetrics: [
          { name: "Crypto", metrics: cryptoMetrics },
          { name: "Stocks", metrics: stocksMetrics },
        ],
      });
    } else {
      this.emit({ type: "risk", metrics: cryptoMetrics });
    }
  }

  private triggerPaperExit(asset: Asset, fillPrice: number): void {
    const tracker = this.paperTrackerFor(asset);
    const pos = tracker.getPortfolio().positions.find((p) => p.asset === asset);
    if (!pos) return;
    const order: Order = {
      id: crypto.randomUUID(),
      asset,
      pair: `${asset}/${this.quoteAsset}` as `${string}/${string}`,
      side: OrderSide.Sell,
      type: OrderType.Market,
      quantity: pos.quantity,
      price: fillPrice,
      status: OrderStatus.Filled,
      paperId: `PAPER-SL-${asset}`,
      createdAt: Date.now(),
      filledAt: Date.now(),
    };
    tracker.onOrderFilled(order, fillPrice);
    this.recentTrades.unshift(order);
    if (this.recentTrades.length > 50) this.recentTrades.pop();
    this.emit({ type: "order", order });
    this.emitPortfolio();
    console.log(`[Engine][PAPER] ${asset} stop-loss/take-profit triggered @ ${fillPrice}`);
  }

  private async subscribeAllTicks(): Promise<void> {
    for (const asset of this.assets) {
      const unsub = await this.broker.subscribeTicks(asset, this.quoteAsset, (price) => {
        if (!this.paperMode) return;
        const fillPrice = this.paperTrackerFor(asset).checkPriceTrigger(asset, price);
        if (fillPrice !== null) this.triggerPaperExit(asset, fillPrice);
      });
      this.tickUnsubscribers.set(asset, unsub);
    }
    console.log(`[Engine] Subscribed to live ticks for ${this.assets.join(", ")}`);
  }

  private saveState(): void {
    try {
      const state = {
        savedAt: Date.now(),
        recentTrades: this.recentTrades,
        cryptoPaperTracker: this.cryptoPaperTracker.serialise(),
        stocksPaperTracker: this.stocksPaperTracker.serialise(),
        detectors: Object.fromEntries(
          this.assets.map((a) => [a, this.detectors.get(a)!.serialise()])
        ),
        slowDetectors: Object.fromEntries(
          this.assets.map((a) => [a, this.slowDetectors.get(a)!.serialise()])
        ),
      };
      writeFileSync(STATE_PATH, JSON.stringify(state), "utf-8");
    } catch (err) {
      console.warn("[Engine] Failed to save state:", (err as Error).message);
    }
  }

  private loadState(): void {
    try {
      const raw = readFileSync(STATE_PATH, "utf-8");
      const state = JSON.parse(raw);
      console.log(`[Engine] Loading saved state from ${new Date(state.savedAt).toISOString()}`);

      this.recentTrades = state.recentTrades ?? [];
      this.cryptoPaperTracker.restore(state.cryptoPaperTracker);
      this.stocksPaperTracker.restore(state.stocksPaperTracker);

      for (const asset of this.assets) {
        if (state.detectors?.[asset]) this.detectors.get(asset)!.restore(state.detectors[asset]);
        if (state.slowDetectors?.[asset]) this.slowDetectors.get(asset)!.restore(state.slowDetectors[asset]);
      }
    } catch {
      console.log("[Engine] No saved state found — starting fresh");
    }
  }

  private msUntilNextCandle(): number {
    const resolutionMs = config.hmm.candleResolutionMinutes * 60 * 1000;
    const now = Date.now();
    return resolutionMs - (now % resolutionMs);
  }

  getSnapshot() {
    const regimes: Record<Asset, RegimeState> = {} as Record<Asset, RegimeState>;
    const regimeSequences: Record<Asset, MarketRegime[]> = {} as Record<Asset, MarketRegime[]>;
    const candles: Record<Asset, Candle[]> = {} as Record<Asset, Candle[]>;
    const latestCandles: Record<Asset, Candle> = {} as Record<Asset, Candle>;

    for (const asset of this.assets) {
      const buffer = this.candleBuffers.get(asset) ?? [];
      const detector = this.detectors.get(asset)!;

      candles[asset] = buffer;
      if (buffer.length > 0) {
        latestCandles[asset] = buffer[buffer.length - 1];
        if (detector.isTrained) {
          regimes[asset] = detector.currentRegime(buffer);
          regimeSequences[asset] = detector.decodeSequence(buffer);
        }
      }
    }

    const combined = this.paperMode ? this.combinedPaperPortfolio() : undefined;
    const brokers = this.portfolio.brokers?.map((b) => ({
      ...b,
      paper: this.paperMode
        ? (b.name === "Stocks" ? this.stocksPaperTracker.getPortfolio() : this.cryptoPaperTracker.getPortfolio())
        : undefined,
    }));

    const cryptoMetrics = this.cryptoRiskManager.getMetrics();
    const brokerMetrics = this.stocksRiskManager
      ? [
          { name: "Crypto", metrics: cryptoMetrics },
          { name: "Stocks", metrics: this.stocksRiskManager.getMetrics() },
        ]
      : undefined;

    return {
      paperMode: this.paperMode,
      assets: this.assets,
      portfolio: { ...this.portfolio, paper: combined, brokers },
      riskMetrics: cryptoMetrics,
      brokerMetrics,
      regimes,
      regimeSequences,
      candles,
      latestCandles,
      recentTrades: this.recentTrades,
    };
  }
}
