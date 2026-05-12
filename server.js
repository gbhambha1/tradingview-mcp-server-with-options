import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import YahooFinance from "yahoo-finance2";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const server = new McpServer({
  name: "options-mcp",
  version: "1.0.0",
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return "N/A";
  return Number(n).toFixed(decimals);
}

function pct(n) {
  if (n == null || isNaN(n)) return "N/A";
  return (Number(n) * 100).toFixed(1) + "%";
}

// Standard normal CDF approximation (Abramowitz & Stegun)
function normCdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x) / Math.sqrt(2));
  const poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-x * x / 2)));
}

// Black-Scholes call delta
function bsDelta(S, K, T, sigma, r = 0.045) {
  if (T <= 0 || sigma <= 0) return S > K ? 1 : 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return normCdf(d1);
}

// Fetch expirations for a symbol and find the Date object matching a YYYY-MM-DD string.
// Yahoo requires exact Date object references — constructed dates return empty chains.
async function getExpirations(symbol) {
  const result = await yf.options(symbol.toUpperCase());
  return { expirationDates: result.expirationDates, quote: result.quote };
}

async function findExpDate(symbol, dateStr) {
  const { expirationDates, quote } = await getExpirations(symbol);
  const target = dateStr.slice(0, 10); // YYYY-MM-DD
  const match = expirationDates.find(
    (d) => new Date(d).toISOString().slice(0, 10) === target
  );
  if (!match) {
    const available = expirationDates
      .slice(0, 8)
      .map((d) => new Date(d).toISOString().slice(0, 10))
      .join(", ");
    throw new Error(`No expiration matching ${dateStr}. Nearest: ${available}`);
  }
  return { expDate: match, quote };
}

// ─── tool: options_get_expirations ───────────────────────────────────────────

server.tool(
  "options_get_expirations",
  "List all available options expiration dates for a symbol. Always call this first to get valid dates for other tools.",
  { symbol: z.string().describe("Ticker symbol, e.g. NVDA") },
  async ({ symbol }) => {
    const { expirationDates, quote } = await getExpirations(symbol);
    const price = quote?.regularMarketPrice;
    const dates = expirationDates.map((d) => new Date(d).toISOString().slice(0, 10));
    return {
      content: [{
        type: "text",
        text: `${symbol.toUpperCase()} — $${fmt(price)} — ${dates.length} expirations:\n${dates.join("\n")}`,
      }],
    };
  }
);

// ─── tool: options_get_chain ──────────────────────────────────────────────────

server.tool(
  "options_get_chain",
  "Get the options chain for a symbol and expiration date. Returns strike, bid, ask, last, volume, open interest, IV, and computed delta.",
  {
    symbol: z.string().describe("Ticker symbol, e.g. NVDA"),
    expiration: z.string().describe("Expiration date YYYY-MM-DD (must be a real date from options_get_expirations)"),
    type: z.enum(["calls", "puts", "both"]).default("calls"),
    min_strike: z.number().optional().describe("Only show strikes at or above this price"),
    max_strike: z.number().optional().describe("Only show strikes at or below this price"),
  },
  async ({ symbol, expiration, type, min_strike, max_strike }) => {
    const ticker = symbol.toUpperCase();
    const { expDate, quote } = await findExpDate(ticker, expiration);
    const result = await yf.options(ticker, { date: expDate });
    const exp = result.options?.[0];
    if (!exp) throw new Error(`No chain data for ${ticker} exp ${expiration}`);

    const currentPrice = result.quote?.regularMarketPrice ?? quote?.regularMarketPrice ?? 0;
    const expMs = new Date(expDate).getTime();
    const T = Math.max(0, (expMs - Date.now()) / (365 * 24 * 3600 * 1000));

    const formatChain = (contracts, label) => {
      let list = contracts ?? [];
      if (min_strike != null) list = list.filter((c) => c.strike >= min_strike);
      if (max_strike != null) list = list.filter((c) => c.strike <= max_strike);
      if (list.length === 0) return `No ${label} in that strike range.`;

      const header =
        `\n=== ${label.toUpperCase()} — ${ticker} exp ${expiration} | Stock: $${fmt(currentPrice)} ===\n` +
        `Strike    Bid     Ask     Last    Vol     OI       IV       Delta  ITM\n` +
        "─".repeat(75);

      const rows = list.map((c) => {
        const iv = c.impliedVolatility ?? 0;
        const delta = bsDelta(currentPrice, c.strike, T, iv);
        return [
          fmt(c.strike, 0).padEnd(9),
          ("$" + fmt(c.bid)).padEnd(7),
          ("$" + fmt(c.ask)).padEnd(7),
          ("$" + fmt(c.lastPrice)).padEnd(7),
          String(c.volume ?? 0).padEnd(7),
          String(c.openInterest ?? 0).padEnd(8),
          pct(iv).padEnd(8),
          fmt(delta, 2).padEnd(6),
          c.inTheMoney ? "✓" : "",
        ].join(" ");
      });

      return header + "\n" + rows.join("\n");
    };

    const parts = [];
    if (type === "calls" || type === "both") parts.push(formatChain(exp.calls, "calls"));
    if (type === "puts" || type === "both") parts.push(formatChain(exp.puts, "puts"));
    parts.push("\nNote: Data ~15 min delayed. Delta computed via Black-Scholes (r=4.5%).");

    return { content: [{ type: "text", text: parts.join("\n\n") }] };
  }
);

// ─── tool: options_get_strike ─────────────────────────────────────────────────

server.tool(
  "options_get_strike",
  "Get full detail for one specific option contract: symbol, expiration, strike, call or put.",
  {
    symbol: z.string().describe("Ticker symbol, e.g. NVDA"),
    expiration: z.string().describe("Expiration date YYYY-MM-DD"),
    strike: z.number().describe("Strike price"),
    type: z.enum(["call", "put"]).describe("Option type"),
  },
  async ({ symbol, expiration, strike, type }) => {
    const ticker = symbol.toUpperCase();
    const { expDate, quote } = await findExpDate(ticker, expiration);
    const result = await yf.options(ticker, { date: expDate });
    const exp = result.options?.[0];
    if (!exp) throw new Error(`No chain data for ${ticker} exp ${expiration}`);

    const currentPrice = result.quote?.regularMarketPrice ?? quote?.regularMarketPrice ?? 0;
    const contracts = type === "call" ? exp.calls : exp.puts;
    const contract = contracts?.find((c) => Math.abs(c.strike - strike) < 0.5);

    if (!contract) {
      const available = contracts?.map((c) => c.strike).join(", ");
      return {
        content: [{
          type: "text",
          text: `No ${type} at $${strike} for ${ticker} exp ${expiration}.\nAvailable: ${available}`,
        }],
      };
    }

    const T = Math.max(0, (new Date(expDate).getTime() - Date.now()) / (365 * 24 * 3600 * 1000));
    const iv = contract.impliedVolatility ?? 0;
    const delta = bsDelta(currentPrice, contract.strike, T, iv);
    const mid = ((contract.bid ?? 0) + (contract.ask ?? 0)) / 2;
    const intrinsic = type === "call"
      ? Math.max(0, currentPrice - contract.strike)
      : Math.max(0, contract.strike - currentPrice);
    const extrinsic = Math.max(0, mid - intrinsic);
    const otmPct = type === "call"
      ? ((contract.strike - currentPrice) / currentPrice) * 100
      : ((currentPrice - contract.strike) / currentPrice) * 100;

    const lines = [
      `${ticker} $${fmt(contract.strike, 0)} ${type.toUpperCase()} — exp ${expiration}`,
      `Stock:          $${fmt(currentPrice)}  (${contract.inTheMoney ? "IN the money" : fmt(otmPct, 1) + "% OTM"})`,
      ``,
      `Bid:            $${fmt(contract.bid)}`,
      `Ask:            $${fmt(contract.ask)}`,
      `Mid:            $${fmt(mid)}`,
      `Last:           $${fmt(contract.lastPrice)}`,
      ``,
      `Volume:         ${contract.volume ?? 0}`,
      `Open interest:  ${contract.openInterest ?? 0}`,
      `Implied vol:    ${pct(iv)}`,
      ``,
      `Intrinsic:      $${fmt(intrinsic)}`,
      `Extrinsic:      $${fmt(extrinsic)}`,
      ``,
      `Delta (BS):     ${fmt(delta, 3)}`,
      `Days to exp:    ${Math.round(T * 365)}`,
      ``,
      `Note: Data ~15 min delayed. Delta via Black-Scholes (r=4.5%).`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── tool: options_covered_call_screen ───────────────────────────────────────

server.tool(
  "options_covered_call_screen",
  "Screen OTM covered call opportunities for a symbol and expiration. Ranks by annualized premium yield. Built for income generation on an existing long equity position.",
  {
    symbol: z.string().describe("Ticker symbol, e.g. NVDA"),
    expiration: z.string().describe("Expiration date YYYY-MM-DD"),
    shares: z.number().optional().default(100).describe("Number of shares held (for total income calc)"),
    max_delta: z.number().optional().default(0.35).describe("Max delta. Lower = less assignment risk. Default 0.35."),
    min_bid: z.number().optional().default(0.50).describe("Min bid price. Filters illiquid strikes. Default $0.50."),
  },
  async ({ symbol, expiration, shares, max_delta, min_bid }) => {
    const ticker = symbol.toUpperCase();
    const { expDate, quote } = await findExpDate(ticker, expiration);
    const result = await yf.options(ticker, { date: expDate });
    const exp = result.options?.[0];
    if (!exp) throw new Error(`No chain data for ${ticker} exp ${expiration}`);

    const currentPrice = result.quote?.regularMarketPrice ?? quote?.regularMarketPrice ?? 0;
    const T = Math.max(1 / 365, (new Date(expDate).getTime() - Date.now()) / (365 * 24 * 3600 * 1000));
    const daysToExp = Math.round(T * 365);
    const numContracts = Math.floor(shares / 100);

    const candidates = (exp.calls ?? [])
      .filter((c) => {
        if (c.inTheMoney) return false;
        if ((c.bid ?? 0) < min_bid) return false;
        const delta = bsDelta(currentPrice, c.strike, T, c.impliedVolatility ?? 0);
        return delta <= max_delta;
      })
      .map((c) => {
        const iv = c.impliedVolatility ?? 0;
        const delta = bsDelta(currentPrice, c.strike, T, iv);
        const bid = c.bid ?? 0;
        const otmPct = ((c.strike - currentPrice) / currentPrice) * 100;
        const totalIncome = bid * numContracts * 100;
        const yieldPct = (bid / currentPrice) * 100;
        const annualizedYield = (yieldPct / daysToExp) * 365;
        return { ...c, delta, iv, otmPct, totalIncome, yieldPct, annualizedYield };
      })
      .sort((a, b) => b.annualizedYield - a.annualizedYield)
      .slice(0, 12);

    if (candidates.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No covered call candidates for ${ticker} exp ${expiration} with delta ≤ ${max_delta} and bid ≥ $${min_bid}.\nTry a closer expiration or looser delta filter.`,
        }],
      };
    }

    const header = [
      `=== COVERED CALL SCREEN: ${ticker} — exp ${expiration} (${daysToExp} days) ===`,
      `Stock: $${fmt(currentPrice)} | Shares: ${shares} (${numContracts} contracts) | Filters: delta ≤ ${max_delta}, bid ≥ $${min_bid}`,
      ``,
      `Strike   % OTM   Bid     Ask     Delta  IV        Yield   Ann.Yield  Income`,
      "─".repeat(80),
    ].join("\n");

    const rows = candidates.map((c) => [
      ("$" + fmt(c.strike, 0)).padEnd(8),
      (fmt(c.otmPct, 1) + "%").padEnd(7),
      ("$" + fmt(c.bid)).padEnd(7),
      ("$" + fmt(c.ask)).padEnd(7),
      fmt(c.delta, 2).padEnd(6),
      pct(c.iv).padEnd(9),
      (fmt(c.yieldPct, 2) + "%").padEnd(7),
      (fmt(c.annualizedYield, 1) + "%").padEnd(10),
      "$" + fmt(c.totalIncome, 0),
    ].join(" "));

    const best = candidates[0];
    const footer = [
      ``,
      `Top pick:  $${fmt(best.strike, 0)} call @ $${fmt(best.bid)} bid — ${fmt(best.annualizedYield, 1)}% ann. yield, $${fmt(best.totalIncome, 0)} total income`,
      ``,
      `Note: Bid price used (conservative). ~15 min delayed. Delta via Black-Scholes.`,
    ].join("\n");

    return {
      content: [{ type: "text", text: header + "\n" + rows.join("\n") + footer }],
    };
  }
);

// ─── tool: options_get_iv_summary ────────────────────────────────────────────

server.tool(
  "options_get_iv_summary",
  "Get current implied volatility snapshot for a symbol. Shows ATM IV from the nearest available expiration.",
  {
    symbol: z.string().describe("Ticker symbol, e.g. NVDA"),
  },
  async ({ symbol }) => {
    const ticker = symbol.toUpperCase();
    const { expirationDates, quote } = await getExpirations(ticker);
    const currentPrice = quote?.regularMarketPrice ?? 0;

    // Use second nearest expiration (skip same-day)
    const nearExpDate = expirationDates[1] ?? expirationDates[0];
    const nearExp = new Date(nearExpDate).toISOString().slice(0, 10);

    const result = await yf.options(ticker, { date: nearExpDate });
    const calls = result.options?.[0]?.calls ?? [];

    const atmCall = calls.reduce((best, c) =>
      best == null || Math.abs(c.strike - currentPrice) < Math.abs(best.strike - currentPrice)
        ? c : best, null);

    const iv = atmCall?.impliedVolatility;
    const hi52 = quote?.fiftyTwoWeekHigh;
    const lo52 = quote?.fiftyTwoWeekLow;
    const pricePosition = hi52 && lo52
      ? ((currentPrice - lo52) / (hi52 - lo52)) * 100
      : null;

    let ivSignal = "Unknown";
    if (iv != null) {
      if (iv > 0.7) ivSignal = `HIGH IV (${pct(iv)}) — elevated premium. Good time to sell covered calls.`;
      else if (iv > 0.4) ivSignal = `MODERATE IV (${pct(iv)}) — reasonable premium available.`;
      else ivSignal = `LOW IV (${pct(iv)}) — premium is thin. May not be worth selling calls right now.`;
    }

    const lines = [
      `=== IV SNAPSHOT: ${ticker} ===`,
      `Current price:    $${fmt(currentPrice)}`,
      hi52 && lo52 ? `52-week range:    $${fmt(lo52)} – $${fmt(hi52)}  (price at ${fmt(pricePosition, 0)}th pctile)` : "",
      ``,
      `Expiration used:  ${nearExp}`,
      `ATM strike:       $${fmt(atmCall?.strike)}`,
      `ATM call IV:      ${iv != null ? pct(iv) : "N/A"}`,
      ``,
      `Signal: ${ivSignal}`,
      ``,
      `Note: True IV Rank requires 52-week IV history (not in free data).`,
      `This is a current ATM IV snapshot. For precise IVR, use tastytrade or IBKR.`,
    ].filter(Boolean);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
