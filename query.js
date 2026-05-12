#!/usr/bin/env node
// Usage:
//   node query.js expirations NVDA
//   node query.js strike NVDA 2026-05-29 250 call
//   node query.js chain NVDA 2026-05-29 [min_strike] [max_strike]
//   node query.js screen NVDA 2026-05-29 [shares=4500] [max_delta=0.35] [min_bid=0.50]
//   node query.js iv NVDA

import YahooFinance from "yahoo-finance2";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return "N/A";
  return Number(n).toFixed(decimals);
}

function pct(n) {
  if (n == null || isNaN(n)) return "N/A";
  return (Number(n) * 100).toFixed(1) + "%";
}

function normCdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x) / Math.sqrt(2));
  const poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-x * x / 2)));
}

function bsDelta(S, K, T, sigma, r = 0.045) {
  if (T <= 0 || sigma <= 0) return S > K ? 1 : 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return normCdf(d1);
}

async function getExpirations(symbol) {
  const result = await yf.options(symbol.toUpperCase());
  return { expirationDates: result.expirationDates, quote: result.quote };
}

async function findExpDate(symbol, dateStr) {
  const { expirationDates, quote } = await getExpirations(symbol);
  const target = dateStr.slice(0, 10);
  const match = expirationDates.find(
    (d) => new Date(d).toISOString().slice(0, 10) === target
  );
  if (!match) {
    const available = expirationDates
      .slice(0, 8)
      .map((d) => new Date(d).toISOString().slice(0, 10))
      .join(", ");
    throw new Error(`No expiration matching ${dateStr}. Available: ${available}`);
  }
  return { expDate: match, quote };
}

// ── commands ──────────────────────────────────────────────────────────────────

async function cmdExpirations(symbol) {
  const { expirationDates, quote } = await getExpirations(symbol);
  const price = quote?.regularMarketPrice;
  const dates = expirationDates.map((d) => new Date(d).toISOString().slice(0, 10));
  console.log(`${symbol.toUpperCase()} — $${fmt(price)} — ${dates.length} expirations:`);
  dates.forEach((d) => console.log(" ", d));
}

async function cmdStrike(symbol, expiration, strike, type) {
  const ticker = symbol.toUpperCase();
  const { expDate, quote } = await findExpDate(ticker, expiration);
  const result = await yf.options(ticker, { date: expDate });
  const exp = result.options?.[0];
  if (!exp) throw new Error(`No chain data for ${ticker} exp ${expiration}`);

  const currentPrice = result.quote?.regularMarketPrice ?? quote?.regularMarketPrice ?? 0;
  const contracts = type === "call" ? exp.calls : exp.puts;
  const contract = contracts?.find((c) => Math.abs(c.strike - Number(strike)) < 0.5);

  if (!contract) {
    const available = contracts?.map((c) => c.strike).join(", ");
    console.log(`No ${type} at $${strike} for ${ticker} exp ${expiration}.`);
    console.log(`Available: ${available}`);
    return;
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

  console.log(`${ticker} $${fmt(contract.strike, 0)} ${type.toUpperCase()} — exp ${expiration}`);
  console.log(`Stock:          $${fmt(currentPrice)}  (${contract.inTheMoney ? "IN the money" : fmt(otmPct, 1) + "% OTM"})`);
  console.log(``);
  console.log(`Bid:            $${fmt(contract.bid)}`);
  console.log(`Ask:            $${fmt(contract.ask)}`);
  console.log(`Mid:            $${fmt(mid)}`);
  console.log(`Last:           $${fmt(contract.lastPrice)}`);
  console.log(``);
  console.log(`Volume:         ${contract.volume ?? 0}`);
  console.log(`Open interest:  ${contract.openInterest ?? 0}`);
  console.log(`Implied vol:    ${pct(iv)}`);
  console.log(``);
  console.log(`Intrinsic:      $${fmt(intrinsic)}`);
  console.log(`Extrinsic:      $${fmt(extrinsic)}`);
  console.log(``);
  console.log(`Delta (BS):     ${fmt(delta, 3)}`);
  console.log(`Days to exp:    ${Math.round(T * 365)}`);
}

async function cmdChain(symbol, expiration, minStrike, maxStrike) {
  const ticker = symbol.toUpperCase();
  const { expDate, quote } = await findExpDate(ticker, expiration);
  const result = await yf.options(ticker, { date: expDate });
  const exp = result.options?.[0];
  if (!exp) throw new Error(`No chain data for ${ticker} exp ${expiration}`);

  const currentPrice = result.quote?.regularMarketPrice ?? quote?.regularMarketPrice ?? 0;
  const T = Math.max(0, (new Date(expDate).getTime() - Date.now()) / (365 * 24 * 3600 * 1000));

  let calls = exp.calls ?? [];
  if (minStrike != null) calls = calls.filter((c) => c.strike >= Number(minStrike));
  if (maxStrike != null) calls = calls.filter((c) => c.strike <= Number(maxStrike));

  console.log(`=== CALLS — ${ticker} exp ${expiration} | Stock: $${fmt(currentPrice)} ===`);
  console.log(`Strike    Bid     Ask     Last    Vol     OI       IV       Delta  ITM`);
  console.log("─".repeat(75));
  for (const c of calls) {
    const iv = c.impliedVolatility ?? 0;
    const delta = bsDelta(currentPrice, c.strike, T, iv);
    console.log([
      fmt(c.strike, 0).padEnd(9),
      ("$" + fmt(c.bid)).padEnd(7),
      ("$" + fmt(c.ask)).padEnd(7),
      ("$" + fmt(c.lastPrice)).padEnd(7),
      String(c.volume ?? 0).padEnd(7),
      String(c.openInterest ?? 0).padEnd(8),
      pct(iv).padEnd(8),
      fmt(delta, 2).padEnd(6),
      c.inTheMoney ? "✓" : "",
    ].join(" "));
  }
}

async function cmdScreen(symbol, expiration, shares = 4500, maxDelta = 0.35, minBid = 0.50) {
  const ticker = symbol.toUpperCase();
  const { expDate, quote } = await findExpDate(ticker, expiration);
  const result = await yf.options(ticker, { date: expDate });
  const exp = result.options?.[0];
  if (!exp) throw new Error(`No chain data for ${ticker} exp ${expiration}`);

  const currentPrice = result.quote?.regularMarketPrice ?? quote?.regularMarketPrice ?? 0;
  const T = Math.max(1 / 365, (new Date(expDate).getTime() - Date.now()) / (365 * 24 * 3600 * 1000));
  const daysToExp = Math.round(T * 365);
  const numContracts = Math.floor(Number(shares) / 100);

  const candidates = (exp.calls ?? [])
    .filter((c) => {
      if (c.inTheMoney) return false;
      if ((c.bid ?? 0) < Number(minBid)) return false;
      const delta = bsDelta(currentPrice, c.strike, T, c.impliedVolatility ?? 0);
      return delta <= Number(maxDelta);
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
    console.log(`No candidates for ${ticker} exp ${expiration} with delta ≤ ${maxDelta} and bid ≥ $${minBid}.`);
    return;
  }

  console.log(`=== COVERED CALL SCREEN: ${ticker} — exp ${expiration} (${daysToExp} days) ===`);
  console.log(`Stock: $${fmt(currentPrice)} | Shares: ${shares} (${numContracts} contracts) | Filters: delta ≤ ${maxDelta}, bid ≥ $${minBid}`);
  console.log(``);
  console.log(`Strike   % OTM   Bid     Ask     Delta  IV        Yield   Ann.Yield  Income`);
  console.log("─".repeat(80));
  for (const c of candidates) {
    console.log([
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
  }
  const best = candidates[0];
  console.log(`\nTop pick: $${fmt(best.strike, 0)} call @ $${fmt(best.bid)} bid — ${fmt(best.annualizedYield, 1)}% ann. yield, $${fmt(best.totalIncome, 0)} total income`);
}

async function cmdIV(symbol) {
  const ticker = symbol.toUpperCase();
  const { expirationDates, quote } = await getExpirations(ticker);
  const currentPrice = quote?.regularMarketPrice ?? 0;
  const nearExpDate = expirationDates[1] ?? expirationDates[0];
  const nearExp = new Date(nearExpDate).toISOString().slice(0, 10);
  const result = await yf.options(ticker, { date: nearExpDate });
  const calls = result.options?.[0]?.calls ?? [];
  const atmCall = calls.reduce((best, c) =>
    best == null || Math.abs(c.strike - currentPrice) < Math.abs(best.strike - currentPrice) ? c : best, null);
  const iv = atmCall?.impliedVolatility;
  const hi52 = quote?.fiftyTwoWeekHigh;
  const lo52 = quote?.fiftyTwoWeekLow;
  const pricePosition = hi52 && lo52 ? ((currentPrice - lo52) / (hi52 - lo52)) * 100 : null;
  let ivSignal = "Unknown";
  if (iv != null) {
    if (iv > 0.7) ivSignal = `HIGH IV (${pct(iv)}) — elevated premium. Good time to sell covered calls.`;
    else if (iv > 0.4) ivSignal = `MODERATE IV (${pct(iv)}) — reasonable premium available.`;
    else ivSignal = `LOW IV (${pct(iv)}) — premium is thin.`;
  }
  console.log(`=== IV SNAPSHOT: ${ticker} ===`);
  console.log(`Current price:    $${fmt(currentPrice)}`);
  if (hi52 && lo52) console.log(`52-week range:    $${fmt(lo52)} – $${fmt(hi52)}  (price at ${fmt(pricePosition, 0)}th pctile)`);
  console.log(`Expiration used:  ${nearExp}`);
  console.log(`ATM strike:       $${fmt(atmCall?.strike)}`);
  console.log(`ATM call IV:      ${iv != null ? pct(iv) : "N/A"}`);
  console.log(`Signal: ${ivSignal}`);
}

async function cmdRange(symbol, period = 14) {
  const ticker = symbol.toUpperCase();
  const N = Number(period);

  // Need enough bars: ADX warmup (2*N) + BB (20) + buffer
  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - 6);

  const bars = await yf.chart(ticker, {
    period1: start.toISOString().slice(0, 10),
    period2: end.toISOString().slice(0, 10),
    interval: "1d",
  });

  const quotes = bars.quotes.filter((b) => b.close != null);
  const closes = quotes.map((b) => b.close);
  const highs  = quotes.map((b) => b.high);
  const lows   = quotes.map((b) => b.low);
  const price  = closes[closes.length - 1];

  // ── ADX (Wilder's smoothing) ──────────────────────────────────────────────
  const trArr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < quotes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    );
    const up   = highs[i]  - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    trArr.push(tr);
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }

  // Wilder smoothing for TR/DM: first value = sum of first N bars
  function wilderSmoothSum(arr, n) {
    let val = arr.slice(0, n).reduce((a, b) => a + b, 0);
    const out = [val];
    for (let i = n; i < arr.length; i++) {
      val = val - val / n + arr[i];
      out.push(val);
    }
    return out;
  }

  // Wilder smoothing for DX→ADX: first value = average of first N bars
  function wilderSmoothAvg(arr, n) {
    let val = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
    const out = [val];
    for (let i = n; i < arr.length; i++) {
      val = (val * (n - 1) + arr[i]) / n;
      out.push(val);
    }
    return out;
  }

  const sTR  = wilderSmoothSum(trArr,   N);
  const sPDM = wilderSmoothSum(plusDM,  N);
  const sMDM = wilderSmoothSum(minusDM, N);

  const dxArr = sTR.map((tr, i) => {
    const pdi = tr === 0 ? 0 : (sPDM[i] / tr) * 100;
    const mdi = tr === 0 ? 0 : (sMDM[i] / tr) * 100;
    const s   = pdi + mdi;
    return s === 0 ? 0 : (Math.abs(pdi - mdi) / s) * 100;
  });

  const adxArr = wilderSmoothAvg(dxArr, N);
  const adx    = adxArr[adxArr.length - 1];
  const lastTR = sTR[sTR.length - 1];
  const pdi    = lastTR === 0 ? 0 : (sPDM[sPDM.length - 1] / lastTR) * 100;
  const mdi    = lastTR === 0 ? 0 : (sMDM[sMDM.length - 1] / lastTR) * 100;

  // ── Bollinger Bands (20-period) ───────────────────────────────────────────
  const BB = 20;
  const bbCloses = closes.slice(-BB);
  const bbMean   = bbCloses.reduce((a, b) => a + b, 0) / BB;
  const bbStd    = Math.sqrt(bbCloses.map((c) => (c - bbMean) ** 2).reduce((a, b) => a + b, 0) / BB);
  const bbUpper  = bbMean + 2 * bbStd;
  const bbLower  = bbMean - 2 * bbStd;
  const bbWidth  = ((bbUpper - bbLower) / bbMean) * 100;

  // BB width 4 weeks ago for trend comparison
  const bbOld    = closes.slice(-BB - 20, -20);
  const bbOldMean = bbOld.reduce((a, b) => a + b, 0) / BB;
  const bbOldStd  = Math.sqrt(bbOld.map((c) => (c - bbOldMean) ** 2).reduce((a, b) => a + b, 0) / BB);
  const bbWidthOld = ((bbOldMean + 2 * bbOldStd - (bbOldMean - 2 * bbOldStd)) / bbOldMean) * 100;
  const bbTrend   = bbWidth < bbWidthOld ? "contracting ↓" : "expanding ↑";

  // ── 20-day price range ────────────────────────────────────────────────────
  const recentHighs  = highs.slice(-20);
  const recentLows   = lows.slice(-20);
  const rangeHigh    = Math.max(...recentHighs);
  const rangeLow     = Math.min(...recentLows);
  const rangePct     = ((rangeHigh - rangeLow) / rangeLow) * 100;
  const priceInRange = ((price - rangeLow) / (rangeHigh - rangeLow)) * 100;

  // ── verdict ───────────────────────────────────────────────────────────────
  const isRangeBound = adx < 20;
  const isWeakTrend  = adx >= 20 && adx < 25;
  const verdict =
    adx < 20  ? "✅ RANGE-BOUND — good for mean-reversion / iron condor strategies" :
    adx < 25  ? "⚠️  WEAK TREND — borderline, use caution with range strategies" :
                "❌ TRENDING — avoid range strategies, follow the trend";

  console.log(`=== RANGE-BOUND ANALYSIS: ${ticker} ===`);
  console.log(`Price: $${fmt(price)}`);
  console.log(``);
  console.log(`ADX(${N}):          ${fmt(adx)}  →  ${verdict}`);
  console.log(`  +DI: ${fmt(pdi)}  -DI: ${fmt(mdi)}  ${pdi > mdi ? "(bullish bias)" : "(bearish bias)"}`);
  console.log(``);
  console.log(`Bollinger Width:  ${fmt(bbWidth)}%  (4 weeks ago: ${fmt(bbWidthOld)}%)  →  ${bbTrend}`);
  console.log(`  Upper: $${fmt(bbUpper)}  Mid: $${fmt(bbMean)}  Lower: $${fmt(bbLower)}`);
  console.log(``);
  console.log(`20-day range:     $${fmt(rangeLow)} – $${fmt(rangeHigh)}  (${fmt(rangePct)}% wide)`);
  console.log(`Price position:   ${fmt(priceInRange, 0)}% of range  ${priceInRange > 70 ? "(near top)" : priceInRange < 30 ? "(near bottom)" : "(mid-range)"}`);
  console.log(``);
  if (isRangeBound) {
    console.log(`Range strategy ideas:`);
    console.log(`  • Sell iron condor between $${fmt(rangeLow)} – $${fmt(rangeHigh)}`);
    console.log(`  • Sell covered calls near range top ($${fmt(rangeHigh)})`);
    console.log(`  • Buy at support ($${fmt(rangeLow)}), sell at resistance ($${fmt(rangeHigh)})`);
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

const commands = {
  expirations: () => cmdExpirations(args[0]),
  strike:      () => cmdStrike(args[0], args[1], args[2], args[3] ?? "call"),
  chain:       () => cmdChain(args[0], args[1], args[2], args[3]),
  screen:      () => cmdScreen(args[0], args[1], args[2], args[3], args[4]),
  iv:          () => cmdIV(args[0]),
  range:       () => cmdRange(args[0], args[1]),
};

if (!cmd || !commands[cmd]) {
  console.log("Commands:");
  console.log("  expirations SYMBOL");
  console.log("  strike SYMBOL YYYY-MM-DD STRIKE [call|put]");
  console.log("  chain SYMBOL YYYY-MM-DD [min_strike] [max_strike]");
  console.log("  screen SYMBOL YYYY-MM-DD [shares=4500] [max_delta=0.35] [min_bid=0.50]");
  console.log("  iv SYMBOL");
  console.log("  range SYMBOL [adx_period=14]");
  process.exit(1);
}

commands[cmd]().catch((e) => { console.error("Error:", e.message); process.exit(1); });
