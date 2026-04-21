# AutoTradingBot

HMM-powered crypto trading bot for BTC/AUD and ETH/AUD via Swyftx, with a real-time Next.js dashboard.

## Architecture

```
packages/shared        ← TypeScript types shared between engine and dashboard
apps/engine            ← Trading engine (Node.js) — runs the HMM, places orders, serves WebSocket
apps/dashboard         ← Next.js dashboard — charts, regime panel, risk gauges
```

The engine exposes a WebSocket on port `3001`. The dashboard connects to it and receives live updates for candles, regime state, portfolio, and risk metrics.

---

## Prerequisites

- Node.js 20+
- pnpm 9+
- A [Swyftx](https://swyftx.com.au) account with an API key

Install pnpm if you don't have it:

```bash
npm install -g pnpm@9
```

---

## Setup

**1. Install dependencies**

```bash
pnpm install
```

**2. Create your environment file**

```bash
cp .env.example .env
```

**3. Fill in `.env`**

| Variable | Description | Default |
|---|---|---|
| `SWYFTX_API_KEY` | Your Swyftx API key | required |
| `PAPER_MODE` | `true` = no real orders placed | `true` |
| `ASSETS` | Comma-separated assets to trade | `BTC,ETH` |
| `QUOTE_ASSET` | Quote currency | `AUD` |
| `HMM_CANDLE_RESOLUTION` | Candle size in minutes | `30` |
| `HMM_LOOKBACK_CANDLES` | Candles used for HMM context | `500` |
| `HMM_RETRAIN_INTERVAL_HOURS` | How often to retrain the model | `24` |
| `MAX_DAILY_LOSS_PCT` | Halt if daily loss exceeds this % | `2` |
| `MAX_DRAWDOWN_PCT` | Halt if drawdown from peak exceeds this % | `5` |
| `MAX_POSITION_SIZE_PCT` | Max % of portfolio per trade | `10` |
| `STOP_LOSS_PCT` | Stop loss % below entry | `2` |
| `TAKE_PROFIT_PCT` | Take profit % above entry | `4` |
| `ENGINE_WS_PORT` | WebSocket port | `3001` |
| `NEXT_PUBLIC_ENGINE_WS_URL` | Dashboard WebSocket URL | `ws://localhost:3001` |

> **Never set `PAPER_MODE=false` until you have run backtests and are confident in the strategy.**

---

## Running locally

Start both the engine and dashboard together:

```bash
pnpm dev
```

Or individually:

```bash
# Engine only
pnpm --filter @trading-bot/engine dev

# Dashboard only
pnpm --filter @trading-bot/dashboard dev
```

| Service | URL |
|---|---|
| Dashboard | http://localhost:3000 |
| Engine WebSocket | ws://localhost:3001 |
| Engine status (REST) | http://localhost:3001/status |

On first run the engine will:
1. Connect to Swyftx and authenticate
2. Fetch the last 500 × 30min candles per asset
3. Train the HMM (Baum-Welch, ~150 iterations)
4. Align to the next 30min candle boundary, then start the trading loop

---

## Backtesting

Run backtests against live Swyftx historical data before going live:

```bash
pnpm --filter @trading-bot/engine backtest
```

Example output:

```
── Backtesting BTC/AUD ──
Total return:   14.23% ($1423.00 AUD)
Sharpe ratio:   1.842
Max drawdown:   3.41%
Trades:         47
Win rate:       59.6%
```

The backtester uses a 70/30 train/test split — the HMM trains on the first 70% of candles and the strategy is evaluated on the remaining 30%.

---

## Dashboard

| Panel | Description |
|---|---|
| **Header** | Portfolio value, total P&L, connection status, Paper/Live toggle |
| **Asset tabs** | Switch between BTC/AUD and ETH/AUD |
| **Price chart** | 30min candlesticks coloured by HMM regime (green = Bull, red = Bear, grey = Sideways) |
| **Regime panel** | Current regime + probability bars for all three states |
| **Risk gauges** | Daily P&L and drawdown bars with circuit breaker status |
| **Positions** | Open positions with entry, stop loss, take profit, unrealised P&L |
| **Trade log** | Recent filled orders with timestamp and paper/live indicator |

### Paper / Live toggle

The switch in the header controls trading mode in real time — no restart needed. In **Paper** mode the engine logs all orders but does not send them to Swyftx.

---

## Accessing on mobile (Cloudflare Tunnel)

To reach the dashboard from your phone without a server, use a free [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):

**1. Install cloudflared**

```bash
brew install cloudflared
```

**2. Expose the engine WebSocket**

```bash
cloudflared tunnel --url http://localhost:3001
```

Cloudflare prints a public URL like `https://random-name.trycloudflare.com`.

**3. Update your dashboard env and restart**

```bash
NEXT_PUBLIC_ENGINE_WS_URL=wss://random-name.trycloudflare.com
```

**4. Expose the dashboard the same way**

```bash
cloudflared tunnel --url http://localhost:3000
```

Open that URL on your phone — done.

> The free tunnel URL changes each time you restart `cloudflared`. For a permanent URL, create a named tunnel in a free Cloudflare account.

---

## Deploying to a VPS (always-on)

For trading without keeping your Mac running, a cheap VPS keeps everything alive 24/7.

**Providers:** Hetzner (~€4/month), DigitalOcean (~$6/month), Vultr (~$6/month).

```bash
# On the VPS — install deps
npm install -g pnpm pm2

# Clone and install
git clone <your-repo> && cd AutoTradingBot
pnpm install
pnpm build

# Copy your .env to the VPS, then:
pm2 start apps/engine/dist/index.js --name trading-engine
pm2 save && pm2 startup
```

Set `NEXT_PUBLIC_ENGINE_WS_URL` to your VPS public IP/domain (e.g. `wss://your-vps-ip:3001`), then deploy the dashboard to [Vercel](https://vercel.com) for free:

```bash
cd apps/dashboard && pnpm dlx vercel
```

---

## Risk guardrails

These are enforced before every order and cannot be bypassed:

| Guardrail | Behaviour |
|---|---|
| Daily loss limit | Halts trading for the rest of the day if daily P&L drops below `MAX_DAILY_LOSS_PCT` |
| Peak drawdown | Halts trading if portfolio drops more than `MAX_DRAWDOWN_PCT` from its peak |
| No duplicate positions | Won't open a second position in the same asset |
| Position sizing | Each trade is capped at `MAX_POSITION_SIZE_PCT` of total portfolio value |

When halted, the dashboard shows a red **HALTED** badge in the Risk panel with the reason. Resets automatically at midnight AEST.

---

## How the HMM works

The engine uses a 3-state Hidden Markov Model with multivariate Gaussian emissions, implemented in log-space for numerical stability.

**Observation features (per 30min candle):**
- Log return: `log(close / prev_close)`
- Price range: `(high - low) / close`
- Log volume ratio: `log(volume / 20-bar avg volume)`

**States:** Bull, Bear, Sideways — labelled automatically after training by ranking each state's mean log return (highest = Bull, lowest = Bear).

**Training:** Baum-Welch EM, converges in ~50–150 iterations. Retrains every `HMM_RETRAIN_INTERVAL_HOURS`.

**Inference:** Forward algorithm for real-time regime probabilities. Viterbi decoding for backtest regime sequences.

**Signal rules:**

| Condition | Signal |
|---|---|
| Bull regime + RSI < 70 + confidence > 60% | BUY |
| Bear regime + RSI > 30 + confidence > 60% | SELL |
| Anything else | HOLD |

---

## Project structure

```
AutoTradingBot/
├── .env.example
├── pnpm-workspace.yaml
├── turbo.json
├── packages/
│   └── shared/src/index.ts           ← shared types + WS message contracts
└── apps/
    ├── engine/src/
    │   ├── config.ts                 ← env var validation
    │   ├── brokers/
    │   │   ├── broker.interface.ts   ← pluggable broker interface
    │   │   └── swyftx.broker.ts      ← Swyftx REST + WebSocket adapter
    │   ├── hmm/
    │   │   ├── hmm.ts                ← Baum-Welch + Viterbi
    │   │   └── regime.ts             ← feature extraction + regime labelling
    │   ├── signals/
    │   │   └── signal-generator.ts   ← RSI + regime → trade signal
    │   ├── guardrails/
    │   │   └── risk-manager.ts       ← circuit breakers
    │   ├── engine/
    │   │   └── trading-engine.ts     ← main loop + event emitter
    │   ├── backtest/
    │   │   ├── backtester.ts         ← historical simulation
    │   │   └── run.ts                ← backtest CLI entry point
    │   └── server/
    │       └── ws-server.ts          ← WebSocket + REST /status
    └── dashboard/src/
        ├── app/                      ← Next.js App Router
        ├── components/               ← Header, PriceChart, RegimePanel, RiskGauges, Positions, TradeLog
        ├── hooks/
        │   └── useTradingSocket.ts   ← WebSocket client with auto-reconnect
        └── lib/
            └── utils.ts              ← cn(), formatAUD(), formatPct()
```
