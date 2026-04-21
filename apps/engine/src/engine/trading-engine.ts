import type { Asset, Candle, Order, Portfolio, RegimeState, MarketRegime } from "@trading-bot/shared";
import { OrderSide, OrderStatus, OrderType } from "@trading-bot/shared";
import type { IBroker } from "../brokers/broker.interface.js";
import { RegimeDetector } from "../hmm/regime.js";
import { generateSignal } from "../signals/signal-generator.js";
import { RiskManager } from "../guardrails/risk-manager.js";
import { PaperTracker } from "./paper-tracker.js";
import { config } from "../config.js";

export type EngineEvent =
  | { type: "candle"; asset: Asset; candle: Candle }
  | { type: "regime"; asset: Asset; regime: RegimeState }
  | { type: "order"; order: Order }
  | { type: "portfolio"; portfolio: Portfolio }
  | { type: "risk"; metrics: ReturnType<RiskManager["getMetrics"]> }
  | { type: "mode"; paperMode: boolean };

export type EngineEventHandler = (event: EngineEvent) => void;

export class TradingEngine {
  private broker: IBroker;
  private assets: Asset[];
  private quoteAsset: string;
  private paperMode: boolean;

  private detectors: Map<Asset, RegimeDetector> = new Map();
  private slowDetectors: Map<Asset, RegimeDetector> = new Map();
  private candleBuffers: Map<Asset, Candle[]> = new Map();
  private slowCandleBuffers: Map<Asset, Candle[]> = new Map();
  private recentTrades: Order[] = [];
  private paperTracker: PaperTracker = new PaperTracker(0);
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

  private riskManager: RiskManager;
  private intervalHandle: NodeJS.Timeout | null = null;
  private listeners: EngineEventHandler[] = [];

  constructor(broker: IBroker) {
    this.broker = broker;
    this.assets = config.trading.assets;
    this.quoteAsset = config.trading.quoteAsset;
    this.paperMode = config.trading.paperMode;

    for (const asset of this.assets) {
      this.detectors.set(asset, new RegimeDetector(asset));
      this.slowDetectors.set(asset, new RegimeDetector(asset));
      this.candleBuffers.set(asset, []);
      this.slowCandleBuffers.set(asset, []);
    }

    this.riskManager = new RiskManager(
      () => this.portfolio,
      this.paperMode ? () => this.paperTracker.getPortfolio() : undefined,
    );
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
    const paperBalance = this.portfolio.totalValueAUD > 0
      ? this.portfolio.totalValueAUD
      : config.trading.paperStartingBalance;
    this.riskManager.reset(paperBalance);
    this.paperTracker.reset(paperBalance);

    await this.initialise();
    await this.subscribeAllTicks();

    // Align to next 30-min boundary, then run every 30 min
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

  private async initialise(): Promise<void> {
    for (const asset of this.assets) {
      const [candles, slowCandles] = await Promise.all([
        this.broker.getCandles(asset, this.quoteAsset, config.hmm.candleResolutionMinutes, config.hmm.lookbackCandles),
        this.broker.getCandles(asset, this.quoteAsset, config.hmm.slowCandleResolutionMinutes, config.hmm.slowLookbackCandles),
      ]);

      this.candleBuffers.set(asset, candles);
      this.slowCandleBuffers.set(asset, slowCandles);

      this.detectors.get(asset)!.train(candles);
      this.slowDetectors.get(asset)!.train(slowCandles);

      console.log(`[Engine] Initialised ${asset} — fast: ${candles.length} candles, slow: ${slowCandles.length} candles`);
    }

    this.emitPortfolio();
  }

  private async tick(): Promise<void> {
    console.log(`[Engine] Tick @ ${new Date().toISOString()}`);

    this.portfolio = await this.broker.getPortfolio();
    this.updatePeak();

    // Update paper tracker with latest prices from candle closes
    const prices: Record<Asset, number> = {};
    for (const asset of this.assets) {
      const buffer = this.candleBuffers.get(asset) ?? [];
      if (buffer.length > 0) prices[asset] = buffer[buffer.length - 1].close;
    }
    this.paperTracker.updatePrices(prices);

    // Candle-based stop-loss/take-profit: fill at the level price, not the close
    for (const asset of this.assets) {
      const buffer = this.candleBuffers.get(asset) ?? [];
      if (buffer.length === 0) continue;
      const latest = buffer[buffer.length - 1];
      const fillPrice = this.paperTracker.checkCandleTrigger(asset, latest.low, latest.high);
      if (fillPrice !== null) this.triggerPaperExit(asset, fillPrice);
    }

    this.emitPortfolio();
    this.emit({ type: "risk", metrics: this.riskManager.getMetrics() });

    for (const asset of this.assets) {
      await this.processAsset(asset);
    }

    // Periodic retrain
    for (const asset of this.assets) {
      const detector = this.detectors.get(asset)!;
      const hoursSinceTrain = detector.trainedTimestamp
        ? (Date.now() - detector.trainedTimestamp) / 3_600_000
        : Infinity;

      if (hoursSinceTrain >= config.hmm.retrainIntervalHours) {
        detector.train(this.candleBuffers.get(asset)!);
        this.slowDetectors.get(asset)!.train(this.slowCandleBuffers.get(asset)!);
      }
    }
  }

  private async processAsset(asset: Asset): Promise<void> {
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

    const regime = detector.currentRegime(candles);
    const slowRegime = slowDetector.currentRegime(slowCandles);
    this.emit({ type: "regime", asset, regime });

    const signal = generateSignal({
      asset,
      quoteAsset: this.quoteAsset,
      candles,
      regime,
      slowRegime,
    });

    console.log(`[Engine] ${asset} signal=${signal.type} regime=${regime.regime} rsi=${signal.rsi.toFixed(1)}`);

    const decision = this.riskManager.evaluate(signal);
    if (!decision.approved || !decision.params) {
      console.log(`[Engine] ${asset} rejected: ${decision.reason}`);
      return;
    }

    const order = await this.broker.placeOrder(decision.params);
    if (order.status === OrderStatus.Filled) {
      this.recentTrades.unshift(order);
      if (this.recentTrades.length > 50) this.recentTrades.pop();

      if (order.paperId) {
        this.paperTracker.onOrderFilled(order, latest.close);
        this.emitPortfolio();
      }

      this.emit({ type: "order", order });
    }

    this.emit({ type: "risk", metrics: this.riskManager.getMetrics() });
  }

  private emitPortfolio(): void {
    const portfolioWithPaper: Portfolio = {
      ...this.portfolio,
      paper: this.paperMode ? this.paperTracker.getPortfolio() : undefined,
    };
    this.emit({ type: "portfolio", portfolio: portfolioWithPaper });
  }

  private triggerPaperExit(asset: Asset, fillPrice: number): void {
    const pos = this.paperTracker.getPortfolio().positions.find((p) => p.asset === asset);
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
    this.paperTracker.onOrderFilled(order, fillPrice);
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
        const fillPrice = this.paperTracker.checkPriceTrigger(asset, price);
        if (fillPrice !== null) {
          this.triggerPaperExit(asset, fillPrice);
        }
      });
      this.tickUnsubscribers.set(asset, unsub);
    }
    console.log(`[Engine] Subscribed to live ticks for ${this.assets.join(", ")}`);
  }

  private updatePeak(): void {
    if (this.portfolio.totalValueAUD > this.portfolio.peakValueAUD) {
      this.portfolio.peakValueAUD = this.portfolio.totalValueAUD;
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

    return {
      paperMode: this.paperMode,
      assets: this.assets,
      portfolio: {
        ...this.portfolio,
        paper: this.paperMode ? this.paperTracker.getPortfolio() : undefined,
      },
      riskMetrics: this.riskManager.getMetrics(),
      regimes,
      regimeSequences,
      candles,
      latestCandles,
      recentTrades: this.recentTrades,
    };
  }
}
