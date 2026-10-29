/* Standalone engine: runs inside the app, fetches Yahoo data directly from the phone (no server). */
(function () {
const UNIVERSE = {"Banks": "HDFCBANK ICICIBANK SBIN KOTAKBANK AXISBANK INDUSINDBK BANKBARODA PNB FEDERALBNK IDFCFIRSTB AUBANK CANBK", "Financials": "BAJFINANCE BAJAJFINSV SHRIRAMFIN CHOLAFIN MUTHOOTFIN SBILIFE HDFCLIFE ICICIPRULI ICICIGI PFC RECLTD HDFCAMC", "IT": "TCS INFY WIPRO HCLTECH TECHM LTIM PERSISTENT COFORGE MPHASIS", "Auto": "MARUTI M&M BAJAJ-AUTO EICHERMOT HEROMOTOCO TVSMOTOR ASHOKLEY BOSCHLTD MOTHERSON", "Pharma": "SUNPHARMA DRREDDY CIPLA DIVISLAB LUPIN AUROPHARMA TORNTPHARM ZYDUSLIFE APOLLOHOSP BIOCON", "FMCG": "HINDUNILVR ITC NESTLEIND BRITANNIA DABUR GODREJCP MARICO COLPAL TATACONSUM", "Metals": "TATASTEEL JSWSTEEL HINDALCO VEDL JINDALSTEL SAIL NMDC NATIONALUM", "Oil & Gas": "RELIANCE ONGC BPCL IOC GAIL PETRONET COALINDIA", "Power": "NTPC POWERGRID TATAPOWER ADANIPOWER JSWENERGY", "Infra & Capital Goods": "LT SIEMENS ABB BHEL HAL BEL CUMMINSIND POLYCAB HAVELLS ADANIENT ADANIPORTS", "Cement": "ULTRACEMCO GRASIM AMBUJACEM SHREECEM", "Realty": "DLF GODREJPROP OBEROIRLTY LODHA", "Consumer": "TITAN ASIANPAINT TRENT PIDILITIND PAGEIND JUBLFOOD ETERNAL INDIGO", "Telecom": "BHARTIARTL IDEA"};
const SECTOR_OF = {}, SYMS = [];
for (const [sec, s] of Object.entries(UNIVERSE)) for (const x of s.split(" ")) { SECTOR_OF[x] = sec; SYMS.push(x); }
const IST = 19800, W = [1/3, 1/3, 1/3];                      // R Factor weights (same formula as the PC version)
const REFRESH = +(localStorage.getItem("refresh") || 30);    // seconds; Yahoo free data cannot sustain 5s for ~110 stocks
const HDR = { "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" };
const S = { seq: 0, ts: 0, data_ts: 0, updated: null, stocks: [], sectors: [], error: null, source: "yahoo" };
let daily = {}, dailyAt = 0, fails = 0, timer = null, running = null, want1m = false, chain = false, m1 = null, ERR = [];
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const dayKey = t => Math.floor((t + IST) / 86400);
function marketOpen() { const d = new Date(Date.now() + IST * 1000), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && m >= 555 && m <= 930; }
async function chart(sym, range, interval) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym + ".NS")}?range=${range}&interval=${interval}`;
  const r = await fetch(u, { headers: HDR }); if (!r.ok) throw new Error("HTTP " + r.status);
  const c = (await r.json()).chart.result[0], q = c.indicators.quote[0], rows = [];
  (c.timestamp || []).forEach((t, i) => { if (q.close[i] != null) rows.push({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }); });
  rows.meta = c.meta || {};
  return rows;
}
async function pool(items, n, fn) {                           // limited concurrency so Yahoo is not flooded
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; ERR.push(e); } } }));
  return out;
}
function row(s, ltp, prev, o, hi, lo, vol, turn, vr, sp, ph, pl, r) {
  const chg = (ltp / prev - 1) * 100; let gt = "", gap = 0;
  if (o > ph) { gt = "up"; gap = (o / ph - 1) * 100; } else if (o < pl) { gt = "down"; gap = (o / pl - 1) * 100; }
  return { sym: s, ltp, chg, open: o, high: hi, low: lo, prev_high: ph, prev_low: pl, volume: vol, turnover: turn, vol_ratio: vr, spike: sp, r,
           gap_type: gt, gap, dir: chg > 0 ? "Bullish" : chg < 0 ? "Bearish" : "Flat" };
}
function metrics(sym, d, i) {
  if (!d || !i || d.length < 15 || !i.length) return null;
  const last = i[i.length - 1], today = dayKey(last.t), h = d.filter(x => dayKey(x.t) < today).slice(-20);   // completed sessions only
  if (h.length < 10) return null;
  const prev = h[h.length - 1].c, ltp = last.c, chg = (ltp / prev - 1) * 100;
  const hi = Math.max(...i.map(x => x.h)), lo = Math.min(...i.map(x => x.l)), rng = (hi - lo) / prev * 100;
  const avgRng = mean(h.map(x => (x.h - x.l) / x.c)) * 100, avgAbs = mean(h.slice(1).map((x, k) => Math.abs(x.c / h[k].c - 1))) * 100;
  const mins = ((last.t + IST) % 86400) / 60 - 555 + 5, frac = Math.min(1, Math.max(0.08, mins / 375));
  const vol = i.reduce((s, x) => s + x.v, 0), avgVol = mean(h.map(x => x.v)), vr = avgVol ? vol / (avgVol * frac) : 0;
  const r = W[0] * rng / (avgRng * Math.sqrt(frac)) + W[1] * Math.abs(chg) / (avgAbs * Math.sqrt(frac)) + W[2] * vr;
  const v = i.map(x => x.v); let sp = 0;
  if (v.length >= 6) { const base = mean(v.slice(0, -3)); if (base > 0) sp = mean(v.slice(-3)) / base; }
  return row(sym, ltp, prev, i[0].o, hi, lo, vol, i.reduce((s, x) => s + x.c * x.v, 0) / 1e7, vr, sp, h[h.length - 1].h, h[h.length - 1].l, r);
}
function build(rows) {
  const secs = {};
  rows.forEach(r => { r.sector = SECTOR_OF[r.sym]; (secs[r.sector] = secs[r.sector] || []).push(r); });
  const sectors = Object.entries(secs).map(([name, rs]) => ({ name, chg: mean(rs.map(x => x.chg)), up: rs.filter(x => x.chg > 0).length, n: rs.length, avg_r: mean(rs.map(x => x.r)) }))
    .sort((a, b) => b.chg - a.chg);
  const sc = Object.fromEntries(sectors.map(s => [s.name, s.chg]));
  rows.forEach(r => { r.signal = "";
    if (r.r >= 1.5 && r.chg > 0.5 && sc[r.sector] > 0) r.signal = "Long watch";
    if (r.r >= 1.5 && r.chg < -0.5 && sc[r.sector] < 0) r.signal = "Short watch"; });
  return [sectors, rows];
}
// ---------- strategies (scan only the F&O list above; only stocks that fully meet every condition are returned) ----------
const CFG = {
  m1: { mins: 1, start: 555, end: 570, n: 5, maxPct: 0.35 },   // 1-minute candles, 09:15-09:30 IST; range = last 5 candles, <= 0.35% wide
  m5: { mins: 5, start: 555, end: 600, n: 4, maxPct: 0.60 },   // 5-minute candles, 09:15-10:00 IST; range = last 4 candles, <= 0.60% wide
  smallBody: 0.5,    // pullback candle body must be <= 50% of the prior trend candle's body
  rangeVolX: 1.5,    // range-breakout candle volume must be >= 1.5x the average volume of the range candles
  minR: 1,           // shortlist: only stocks with R Factor ABOVE this value are scanned (raise to 1.5 or 2 for fewer stocks)
  topSectors: 3      // shortlist: the 3 strongest up sectors (Buy signals only) and 3 strongest down sectors (Sell signals only)
};
const minOf = t => ((t + IST) % 86400) / 60;                  // minute of day in IST
function scan(sym, bars, key) {
  const c = CFG[key], w = bars.filter(b => { const m = minOf(b.t); return m >= c.start && m < c.end; });
  if (w.length < 3) return [];
  const body = b => Math.abs(b.c - b.o), last = bars[bars.length - 1], nowS = Date.now() / 1000;
  const mk = (side, setup, C, entry, h, l, va, vb) => ({ sym, sector: SECTOR_OF[sym], tf: key, setup, side, entry, ltp: last.c, h, l, va, vb, vc: C.v, t: C.t,
    live: marketOpen() && C === last && nowS < C.t + c.mins * 60 });
  let pb = null, rb = null;
  for (let k = 2; k < w.length; k++) {                        // Pullback: A trend candle -> B small counter candle inside A with lower volume -> C breaks B with higher volume
    const A = w[k - 2], B = w[k - 1], C = w[k], small = body(B) <= CFG.smallBody * body(A), inside = B.c >= A.l && B.c <= A.h;
    if (A.c > A.o && B.c < B.o && small && inside && B.h <= A.h && B.v < A.v && C.h > B.h && C.v > B.v) pb = mk("BUY", "Pullback", C, B.h, B.h, B.l, A.v, B.v);
    if (A.c < A.o && B.c > B.o && small && inside && B.l >= A.l && B.v < A.v && C.l < B.l && C.v > B.v) pb = mk("SELL", "Pullback", C, B.l, B.h, B.l, A.v, B.v);
  }
  for (let k = c.n; k < w.length; k++) {                      // Range breakout: tight range of n candles, then a candle closing outside it on strong volume
    const R = w.slice(k - c.n, k), hi = Math.max(...R.map(b => b.h)), lo = Math.min(...R.map(b => b.l)), C = w[k], av = mean(R.map(b => b.v));
    if ((hi - lo) / lo * 100 > c.maxPct || C.v < CFG.rangeVolX * av) continue;
    if (C.c > hi) rb = mk("BUY", "Range breakout", C, hi, hi, lo, av, null);
    else if (C.c < lo) rb = mk("SELL", "Range breakout", C, lo, hi, lo, av, null);
  }
  return [pb, rb].filter(Boolean);
}
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
function friendly(e) {
  const m = String((e && e.message) || e);
  if (/HTTP 429/.test(m)) return "Yahoo is limiting requests (HTTP 429). Wait a minute, then tap refresh.";
  if (/HTTP (401|403)/.test(m)) return "Yahoo refused the request (" + m + "). Try again later.";
  if (/HTTP 5\d\d/.test(m)) return "Yahoo server error (" + m + "). Try again shortly.";
  if (/Failed to fetch|NetworkError|Network request failed|Load failed|timed? ?out/i.test(m)) return "No internet connection, or Yahoo cannot be reached.";
  return m.slice(0, 140);
}
const ok1 = (s, day) => { const b = m1 && m1.day === day && m1.bars[s]; return !!b && dayKey(b[b.length - 1].t) === day && minOf(b[b.length - 1].t) >= 569; };   // stock's 1m candles cover 09:15-09:30
const needs1m = () => S.sday === undefined || (S.short || []).some(s => !ok1(s, S.sday));
async function run() {
  S.loading = true; ERR = [];
  try {
    if (Date.now() - dailyAt > 1800e3) {                      // 20-day baseline, refreshed every 30 min
      const res = await pool(SYMS, 8, s => chart(s, "3mo", "1d"));
      res.forEach((r, k) => { if (r) daily[SYMS[k]] = r; });
      if (Object.keys(daily).length) dailyAt = Date.now();
    }
    const intra = await pool(SYMS, 8, s => chart(s, "1d", "5m")), rows = []; let lastTs = 0;
    SYMS.forEach((s, k) => { try { const m = metrics(s, daily[s], intra[k]); if (m) { rows.push(m); lastTs = Math.max(lastTs, intra[k][intra[k].length - 1].t); } } catch (e) {} });
    if (!rows.length) throw ERR[0] || new Error("No data returned - check internet; Yahoo may be limiting requests");
    const failed = intra.filter(x => !x).length, sday = dayKey(lastTs), [sectors, stocks] = build(rows);
    // Shortlist from the live screening: R Factor above minR, in the most-moving sectors. Up sectors -> Buy signals only, down sectors -> Sell signals only.
    const upS = sectors.filter(s => s.chg > 0).slice(0, CFG.topSectors), dnS = [...sectors].reverse().filter(s => s.chg < 0).slice(0, CFG.topSectors);
    const upSet = new Set(upS.map(s => s.name)), dnSet = new Set(dnS.map(s => s.name)), rOf = Object.fromEntries(rows.map(r => [r.sym, r])), sc = Object.fromEntries(sectors.map(s => [s.name, s.chg]));
    const short = rows.filter(r => r.r > CFG.minR && (upSet.has(r.sector) || dnSet.has(r.sector))).map(r => r.sym);
    if (want1m) {                                             // 1-minute candles: only for shortlisted stocks, and only until their 09:15-09:30 window is complete
      if (!m1 || m1.day !== sday) m1 = { day: sday, bars: {} };
      const need = short.filter(s => !ok1(s, sday)), r1 = await pool(need, 8, s => chart(s, "1d", "1m"));
      need.forEach((s, k) => { if (r1[k] && r1[k].length) m1.bars[s] = r1[k]; });
    }
    const strat = { m1: [], m5: [] }, sinfo = {}, nowMin = minOf(Date.now() / 1000), session = new Date((lastTs + IST) * 1000).toUTCString().slice(5, 16);
    for (const key of ["m5", "m1"]) {
      const by = key === "m5" ? Object.fromEntries(SYMS.map((s, k) => [s, intra[k]])) : (m1 && m1.day === sday ? m1.bars : null); let scanned = 0;
      if (by) for (const s of short) { const b = by[s]; if (b && b.length) { scanned++;
        for (const g of scan(s, b, key)) if (g.side === "BUY" ? upSet.has(g.sector) : dnSet.has(g.sector)) strat[key].push({ ...g, r: rOf[s].r, schg: sc[g.sector] }); } }
      strat[key].sort((x, y) => y.t - x.t);
      sinfo[key] = { ready: !!by, scanned, universe: SYMS.length, session, active: marketOpen() && nowMin >= CFG[key].start && nowMin < CFG[key].end };
    }
    const ages = intra.filter(b => b && b.length).map(b => Date.now() / 1000 - b[b.length - 1].t), md = intra.find(b => b && b.meta && b.meta.exchangeDataDelayedBy != null);
    const d = new Date(Date.now() + IST * 1000);
    Object.assign(S, { stocks, sectors, strat, sinfo, sday, short, shortlist: { n: short.length, min_r: CFG.minR, up: upS.map(s => ({ name: s.name, chg: s.chg })), down: dnS.map(s => ({ name: s.name, chg: s.chg })) }, error: null, seq: S.seq + 1, ts: Date.now() / 1000, data_ts: lastTs,
      warn: failed ? failed + " of " + SYMS.length + " stocks could not be loaded" + (ERR[0] ? " (" + friendly(ERR[0]) + ")" : "") : null,
      feed: { provider: "Yahoo Finance (unofficial chart API)", mode: "polled every " + REFRESH + "s, no WebSocket", age_min: ages.length ? median(ages) / 60 : null,
              meta_delay: md ? md.meta.exchangeDataDelayedBy : null },
      updated: d.toUTCString().slice(5, 11) + " " + d.toUTCString().slice(17, 25) });
    fails = 0;
  } catch (e) { fails++; S.error = friendly(e); }
  S.loading = false; running = null;
  let wait = marketOpen() ? REFRESH : 600; if (fails) wait = Math.min(120, REFRESH * 2 ** fails);
  clearTimeout(timer); timer = setTimeout(refresh, wait * 1000);
  if (chain) { chain = false; if (!fails && needs1m()) return refresh(); }
}
function refresh() { if (!running) { clearTimeout(timer); running = run(); } return running; }   // one request cycle at a time: duplicate calls share the running one
(typeof window !== "undefined" ? window : globalThis).Engine = {
  get: async () => ({ ...S, now: Date.now() / 1000, refresh: REFRESH, poll: 5, loading: !!running, market: marketOpen() ? "OPEN" : "CLOSED" }),
  refresh: () => refresh(),
  want1m: () => { want1m = true; if (!needs1m()) return running || Promise.resolve(); chain = true; return refresh(); } };
refresh();
})();
