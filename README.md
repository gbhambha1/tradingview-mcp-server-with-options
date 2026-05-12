# TradingView MCP Server with Options

A two-part toolkit for AI-assisted trading analysis inside [Claude Code](https://claude.ai/code):

1. **Options MCP Server** — real-time options chains, covered call screening, and technical analysis via Yahoo Finance
2. **TradingView MCP Server** — live control of a TradingView Desktop chart (read indicators, switch symbols, manage Pine Scripts, draw shapes, and more)

---

## Options Tools

### MCP Server (`server.js`)

Run as an MCP server inside Claude Code. Exposes 5 tools:

| Tool | Description |
|------|-------------|
| `options_get_expirations` | List all valid expiration dates for a symbol |
| `options_get_chain` | Full call/put chain with strike, bid, ask, IV, delta |
| `options_get_strike` | Deep detail on one specific contract |
| `options_covered_call_screen` | Ranks OTM calls by annualized yield, filters by delta |
| `options_get_iv_summary` | ATM IV snapshot from nearest expiration |

### CLI (`query.js`)

Standalone command-line tool — no MCP server required.

```bash
node query.js expirations NVDA
node query.js strike NVDA 2026-06-20 250 call
node query.js chain NVDA 2026-06-20 230 270
node query.js screen NVDA 2026-06-20 4500 0.35 0.50
node query.js iv NVDA
node query.js range MSFT
```

**Range-bound analysis** (`range` command) computes:
- **ADX(14)** — ADX < 20 = range-bound, > 25 = trending
- **Bollinger Band width** — contracting vs expanding
- **20-day price range** — support/resistance levels
- **Verdict** + range strategy suggestions (iron condor, covered calls)

### Daily Monitor (`monitor.js`)

Runs at market close. Computes RSI(14) and MACD(12,26,9) from daily bars, fires a macOS notification, and logs results.

```bash
node monitor.js NVDA
```

**Alerts on:**
- RSI ≥ 70 (overbought) or RSI ≤ 30 (oversold)
- MACD bullish or bearish crossover

**Set up as a daily cron (4:30 PM ET, weekdays):**

```
30 16 * * 1-5 /usr/local/bin/node /path/to/monitor.js NVDA >> /path/to/monitor.log 2>&1
```

---

## TradingView MCP Server (`tradingview-mcp/`)

Controls a live TradingView Desktop session via Chrome DevTools Protocol. See [`tradingview-mcp/README.md`](tradingview-mcp/README.md) for full setup and tool reference.

**Key capabilities:**
- Read live indicator values (RSI, MACD, EMA, custom Pine indicators)
- Switch symbols, timeframes, and chart types
- Add/remove indicators
- Read Pine Script output (labels, lines, tables, boxes)
- Take screenshots, manage alerts, control replay mode
- Write and compile Pine Scripts

**Local modifications in this repo:**
- `src/server.js` — added `uncaughtException` / `unhandledRejection` handlers to keep the MCP server alive on errors instead of requiring a full reconnect
- `rules.json` — EMA-21 long-only strategy rules and indicator rationale

---

## Setup

### Prerequisites

- Node.js v18+
- Claude Code CLI

### Options MCP Server

```bash
cd options-mcp
npm install
```

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "options": {
      "command": "node",
      "args": ["/path/to/options-mcp/server.js"]
    }
  }
}
```

### TradingView MCP Server

See [`tradingview-mcp/SETUP_GUIDE.md`](tradingview-mcp/SETUP_GUIDE.md) for full instructions including launching TradingView Desktop in debug mode.

```bash
cd tradingview-mcp
npm install
```

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/path/to/tradingview-mcp/src/server.js"]
    }
  }
}
```

---

## Data & Disclaimers

- Options data is sourced from Yahoo Finance (~15 min delayed). No API key required.
- Delta is computed via Black-Scholes (Abramowitz & Stegun approximation, r = 4.5%).
- TradingView MCP is an unofficial tool. Not affiliated with TradingView Inc. or Anthropic. Ensure your usage complies with [TradingView's Terms of Use](https://www.tradingview.com/policies/).
- Nothing in this repo constitutes financial advice.
