#!/usr/bin/env node
// Daily NVDA technical indicator monitor
// Calculates RSI(14) and MACD(12,26,9) from Yahoo Finance OHLCV data
// Sends a macOS notification and logs to nvda-monitor.log

import YahooFinance from "yahoo-finance2";
import { execSync } from "child_process";
import { appendFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });
const LOG = path.join(path.dirname(fileURLToPath(import.meta.url)), "nvda-monitor.log");
const SYMBOL = process.argv[2] ?? "NVDA";

// ── math ──────────────────────────────────────────────────────────────────────

function emaArray(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function rsi(closes, period = 14) {
  const changes = closes.slice(1).map((p, i) => p - closes[i]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + Math.max(0, changes[i])) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -changes[i])) / period;
  }
  const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = emaArray(closes, fast);
  const emaSlow = emaArray(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  // Signal line starts after enough MACD values exist
  const signalLine = emaArray(macdLine.slice(slow - 1), signal);

  const n = signalLine.length;
  const lastMACD = macdLine[macdLine.length - 1];
  const prevMACD = macdLine[macdLine.length - 2];
  const lastSignal = signalLine[n - 1];
  const prevSignal = signalLine[n - 2];
  const histogram = lastMACD - lastSignal;
  const prevHistogram = prevMACD - prevSignal;

  let crossover = null;
  if (prevMACD <= prevSignal && lastMACD > lastSignal) crossover = "bullish";
  if (prevMACD >= prevSignal && lastMACD < lastSignal) crossover = "bearish";

  return { macd: lastMACD, signal: lastSignal, histogram, prevHistogram, crossover };
}

// ── main ──────────────────────────────────────────────────────────────────────

const now = new Date();
const dateStr = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

// Fetch 3 months of daily bars (need 60+ for MACD warmup)
const queryEnd = new Date();
queryEnd.setDate(queryEnd.getDate() + 1); // +1 so today's bar is included
const queryStart = new Date();
queryStart.setMonth(queryStart.getMonth() - 3);

const result = await yf.historical(SYMBOL, {
  period1: queryStart.toISOString().slice(0, 10),
  period2: queryEnd.toISOString().slice(0, 10),
  interval: "1d",
});

if (!result || result.length < 40) {
  console.error(`Not enough data for ${SYMBOL}`);
  process.exit(1);
}

const closes = result.map((b) => b.close);
const price = closes[closes.length - 1];

const rsiVal = rsi(closes);
const macdVal = macd(closes);

// ── signals ───────────────────────────────────────────────────────────────────

const rsiSignal =
  rsiVal >= 70 ? "🔴 OVERBOUGHT" :
  rsiVal <= 30 ? "🟢 OVERSOLD" :
  rsiVal >= 60 ? "Approaching overbought" :
  rsiVal <= 40 ? "Approaching oversold" :
  "Neutral";

const macdSignal =
  macdVal.crossover === "bullish" ? "🟢 BULLISH CROSSOVER — MACD crossed above signal" :
  macdVal.crossover === "bearish" ? "🔴 BEARISH CROSSOVER — MACD crossed below signal" :
  macdVal.histogram > 0 && macdVal.histogram > macdVal.prevHistogram ? "Bullish — histogram expanding" :
  macdVal.histogram > 0 && macdVal.histogram < macdVal.prevHistogram ? "Bullish — histogram shrinking (weakening)" :
  macdVal.histogram < 0 && Math.abs(macdVal.histogram) > Math.abs(macdVal.prevHistogram) ? "Bearish — histogram expanding" :
  "Bearish — histogram shrinking (weakening)";

const alertNeeded = macdVal.crossover || rsiVal >= 70 || rsiVal <= 30;

// ── output ────────────────────────────────────────────────────────────────────

const summary = [
  `${SYMBOL} Daily Monitor — ${dateStr} ${timeStr}`,
  `Price:     $${price.toFixed(2)}`,
  `RSI(14):   ${rsiVal.toFixed(2)}  →  ${rsiSignal}`,
  `MACD:      ${macdVal.macd.toFixed(3)}  Signal: ${macdVal.signal.toFixed(3)}  Hist: ${macdVal.histogram.toFixed(3)}`,
  `MACD sig:  ${macdSignal}`,
].join("\n");

console.log(summary);

// Log to file
appendFileSync(LOG, "\n" + summary + "\n" + "─".repeat(50));

// macOS notification
const notifTitle = alertNeeded ? `⚠️ ${SYMBOL} Alert` : `${SYMBOL} Daily Check`;
const notifBody = `RSI ${rsiVal.toFixed(1)} | MACD ${macdVal.histogram > 0 ? "+" : ""}${macdVal.histogram.toFixed(2)} hist | ${macdVal.crossover ? macdVal.crossover.toUpperCase() + " CROSSOVER" : "No crossover"}`;

try {
  execSync(
    `osascript -e 'display notification "${notifBody}" with title "${notifTitle}" subtitle "$${price.toFixed(2)}"'`
  );
} catch {
  // Notification failed silently — output already printed above
}
