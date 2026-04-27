import Anthropic from "@anthropic-ai/sdk";
import type { Asset, PaperPortfolio, RegimeState, TradeSignal } from "@trading-bot/shared";

const SYSTEM_PROMPT = `You are a crypto trading signal validator embedded in an automated trading bot.
The bot uses a Hidden Markov Model (HMM) to detect Bull/Bear/Sideways regimes on 15-minute and 1-hour candles.
Assets traded: BTC, ETH, XRP, SOL against USD.

When validating signals:
- RSI >85 is overbought (risky to buy), <30 is oversold (good to buy)
- Strong signals have both 15m and 1h regimes aligned
- Multiple assets in the same regime simultaneously can indicate false signals (correlated noise)
- Be concise and data-focused`;

export interface SignalValidation {
  approved: boolean;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

export class ClaudeAnalytics {
  private client: Anthropic | null = null;
  readonly enabled: boolean;

  constructor() {
    this.enabled = !!process.env.ANTHROPIC_API_KEY;
    if (this.enabled) {
      this.client = new Anthropic();
      console.log("[Claude] Analytics enabled");
    } else {
      console.log("[Claude] No ANTHROPIC_API_KEY — analytics disabled");
    }
  }

  async validateSignal(
    signal: TradeSignal,
    slowRegime: RegimeState,
    allRegimes: Map<Asset, { fast: RegimeState; slow: RegimeState }>,
    portfolio: PaperPortfolio,
    timeoutMs = 5000,
  ): Promise<SignalValidation> {
    if (!this.client) {
      return { approved: true, confidence: "low", reasoning: "Claude disabled" };
    }

    const others = [...allRegimes.entries()]
      .filter(([asset]) => asset !== signal.asset)
      .map(([asset, r]) => `${asset}: 15m=${r.fast.regime}(${(r.fast.confidence * 100).toFixed(0)}%) 1h=${r.slow.regime}`)
      .join(", ");

    const prompt = `Signal: ${signal.type} ${signal.asset}
Reason: ${signal.reason}
15m regime: ${signal.regime} | 1h regime: ${slowRegime.regime} (${(slowRegime.confidence * 100).toFixed(0)}% confidence)
RSI: ${signal.rsi.toFixed(1)} | Price: $${signal.price.toFixed(2)}
Other assets: ${others || "none"}
Portfolio: $${portfolio.totalValue.toFixed(2)} | Open positions: ${portfolio.positions.length}

Respond with JSON only: {"approved": true/false, "confidence": "high"/"medium"/"low", "reasoning": "one sentence"}`;

    try {
      const result = await Promise.race([
        this.client.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 150,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: prompt }],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutMs),
        ),
      ]);

      const text = result.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") throw new Error("no text block");

      const match = text.text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("no JSON in response");

      const parsed = JSON.parse(match[0]) as SignalValidation;
      console.log(`[Claude] ${signal.asset} ${signal.type} → ${parsed.approved ? "APPROVED" : "REJECTED"} (${parsed.confidence}): ${parsed.reasoning}`);
      return parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      console.warn(`[Claude] Signal validation failed (${msg}) — defaulting to approved`);
      return { approved: true, confidence: "low", reasoning: `Claude unavailable: ${msg}` };
    }
  }

  async marketSummary(
    allRegimes: Map<Asset, { fast: RegimeState; slow: RegimeState }>,
    portfolio: PaperPortfolio,
  ): Promise<void> {
    if (!this.client) return;

    const regimeSummary = [...allRegimes.entries()]
      .map(([asset, r]) => `${asset}: 15m=${r.fast.regime}(${(r.fast.confidence * 100).toFixed(0)}%) 1h=${r.slow.regime}(${(r.slow.confidence * 100).toFixed(0)}%)`)
      .join("\n");

    const prompt = `Market snapshot:\n${regimeSummary}\n\nPortfolio: $${portfolio.totalValue.toFixed(2)} (realised PnL: $${portfolio.realisedPnl.toFixed(2)})\nPositions: ${portfolio.positions.map((p) => `${p.asset}@$${p.entryPrice.toFixed(2)}`).join(", ") || "none"}\n\nGive a 2-sentence market overview.`;

    try {
      const stream = this.client.messages.stream({
        model: "claude-haiku-4-5",
        max_tokens: 200,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: prompt }],
      });

      process.stdout.write("\n[Claude] Market summary: ");
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          process.stdout.write(event.delta.text);
        }
      }
      process.stdout.write("\n");
    } catch (err) {
      console.warn(`[Claude] Market summary failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }
}
