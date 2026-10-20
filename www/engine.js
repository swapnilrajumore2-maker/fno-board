/* Standalone engine: runs inside the app, fetches Yahoo data directly from the phone (no server). */
(function () {
const UNIVERSE = {"Banks": "HDFCBANK ICICIBANK SBIN KOTAKBANK AXISBANK INDUSINDBK BANKBARODA PNB FEDERALBNK IDFCFIRSTB AUBANK CANBK", "Financials": "BAJFINANCE BAJAJFINSV SHRIRAMFIN CHOLAFIN MUTHOOTFIN SBILIFE HDFCLIFE ICICIPRULI ICICIGI PFC RECLTD HDFCAMC", "IT": "TCS INFY WIPRO HCLTECH TECHM LTIM PERSISTENT COFORGE MPHASIS", "Auto": "MARUTI M&M BAJAJ-AUTO EICHERMOT HEROMOTOCO TVSMOTOR ASHOKLEY BOSCHLTD MOTHERSON", "Pharma": "SUNPHARMA DRREDDY CIPLA DIVISLAB LUPIN AUROPHARMA TORNTPHARM ZYDUSLIFE APOLLOHOSP BIOCON", "FMCG": "HINDUNILVR ITC NESTLEIND BRITANNIA DABUR GODREJCP MARICO COLPAL TATACONSUM", "Metals": "TATASTEEL JSWSTEEL HINDALCO VEDL JINDALSTEL SAIL NMDC NATIONALUM", "Oil & Gas": "RELIANCE ONGC BPCL IOC GAIL PETRONET COALINDIA", "Power": "NTPC POWERGRID TATAPOWER ADANIPOWER JSWENERGY", "Infra & Capital Goods": "LT SIEMENS ABB BHEL HAL BEL CUMMINSIND POLYCAB HAVELLS ADANIENT ADANIPORTS", "Cement": "ULTRACEMCO GRASIM AMBUJACEM SHREECEM", "Realty": "DLF GODREJPROP OBEROIRLTY LODHA", "Consumer": "TITAN ASIANPAINT TRENT PIDILITIND PAGEIND JUBLFOOD ETERNAL INDIGO", "Telecom": "BHARTIARTL IDEA"};
const SECTOR_OF = {}, SYMS = [];
for (const [sec, s] of Object.entries(UNIVERSE)) for (const x of s.split(" ")) { SECTOR_OF[x] = sec; SYMS.push(x); }
const IST = 19800, W = [1/3, 1/3, 1/3];                      // R Factor weights (same formula as the PC version)
const REFRESH = +(localStorage.getItem("refresh") || 30);    // seconds; Yahoo free data cannot sustain 5s for ~110 stocks
const HDR = { "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" };
const S = { seq: 0, ts: 0, data_ts: 0, updated: null, stocks: [], sectors: [], error: null, source: "yahoo" };
let daily = {}, dailyAt = 0, fails = 0;
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const dayKey = t => Math.floor((t + IST) / 86400);
function marketOpen() { const d = new Date(Date.now() + IST * 1000), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && m >= 555 && m <= 930; }
async function chart(sym, range, interval) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym + ".NS")}?range=${range}&interval=${interval}`;
  const r = await fetch(u, { headers: HDR }); if (!r.ok) throw new Error("HTTP " + r.status);
  const c = (await r.json()).chart.result[0], q = c.indicators.quote[0], rows = [];
  (c.timestamp || []).forEach((t, i) => { if (q.close[i] != null) rows.push({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }); });
  return rows;
}
async function pool(items, n, fn) {                           // limited concurrency so Yahoo is not flooded
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; } } }));
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
async function tick() {
  try {
    if (Date.now() - dailyAt > 1800e3) {                      // 20-day baseline, refreshed every 30 min
      const res = await pool(SYMS, 8, s => chart(s, "3mo", "1d"));
      res.forEach((r, k) => { if (r) daily[SYMS[k]] = r; });
      if (Object.keys(daily).length) dailyAt = Date.now();
    }
    const intra = await pool(SYMS, 8, s => chart(s, "1d", "5m")), rows = []; let lastTs = 0;
    SYMS.forEach((s, k) => { try { const m = metrics(s, daily[s], intra[k]); if (m) { rows.push(m); lastTs = Math.max(lastTs, intra[k][intra[k].length - 1].t); } } catch (e) {} });
    if (!rows.length) throw new Error("No data returned - check internet; Yahoo may be limiting requests");
    const [sectors, stocks] = build(rows), d = new Date(Date.now() + IST * 1000);
    Object.assign(S, { stocks, sectors, error: null, seq: S.seq + 1, ts: Date.now() / 1000, data_ts: lastTs,
      updated: d.toUTCString().slice(5, 11) + " " + d.toUTCString().slice(17, 25) });
    fails = 0;
  } catch (e) { fails++; S.error = String(e.message || e).slice(0, 160); }
  let wait = marketOpen() ? REFRESH : 600; if (fails) wait = Math.min(120, REFRESH * 2 ** fails);
  setTimeout(tick, wait * 1000);
}
(typeof window !== "undefined" ? window : globalThis).Engine = {
  get: async () => ({ ...S, now: Date.now() / 1000, refresh: REFRESH, poll: 5, market: marketOpen() ? "OPEN" : "CLOSED" }) };
tick();
})();
