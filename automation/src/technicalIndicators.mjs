import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SCANNER_COLUMNS = [
  "name", "description", "close", "change", "volume", "relative_volume_10d_calc",
  "market_cap_basic", "SMA5", "SMA10", "SMA20", "RSI", "sector", "exchange",
];

export async function refreshTechnicalIndicators(config, options = {}) {
  const path = resolve(config.dashboardDataFile);
  const data = parseDashboardFile(readFileSync(path, "utf8"));
  const scannerRows = options.scannerRows || await fetchKoreaScanner(options.fetchImpl || fetch);
  const quotes = scannerRows.map(normalizeScannerRow).filter(Boolean);
  const asOfDate = String(data.liveSnapshot?.date || [...(data.dates || [])].sort().at(-1) || "");
  const { seriesByCode, latestByCode } = buildPriceHistory(data, quotes, asOfDate);
  const divergences = detectRsiDivergences(seriesByCode, latestByCode, quotes);
  const turnover = screenTurnover(quotes, latestByCode);
  const alignment = screenAlignmentTransitions(seriesByCode, latestByCode, quotes);

  data.technicalIndicators = {
    updatedAt: new Date().toISOString(),
    asOfDate,
    methodology: {
      rsi: "14일 RSI · 당일 가격이 최근 단기 고점/저점을 갱신했지만 RSI는 반대로 움직인 종목",
      turnover: "거래대금(현재가×거래량) ÷ 시가총액 · 10일 평균 대비 거래량 1.5배 이상",
      alignment: "5일선>10일선>20일선 신규 진입 · 최근 20거래일 안에 역배열 이력 확인",
    },
    rsi: divergences,
    market: { turnover, alignment },
  };
  writeFileSync(path, `window.FLOW_DASHBOARD_DATA=${JSON.stringify(data)};\n`, "utf8");
  return {
    bullish: divergences.bullish.length,
    bearish: divergences.bearish.length,
    turnover: turnover.length,
    alignment: alignment.length,
  };
}

export function calculateRsi(closes, period = 14) {
  const values = closes.map(Number);
  const result = Array(values.length).fill(null);
  if (values.length <= period) return result;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  gain /= period;
  loss /= period;
  result[period] = rsiValue(gain, loss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = rsiValue(gain, loss);
  }
  return result;
}

export function detectRsiDivergences(seriesByCode, latestByCode, quotes = []) {
  const quoteByCode = new Map(quotes.map((quote) => [quote.code, quote]));
  const bullish = [];
  const bearish = [];
  for (const [code, series] of seriesByCode) {
    if (series.length < 20) continue;
    const closes = series.map((row) => row.close);
    const rsi = calculateRsi(closes);
    const currentIndex = series.length - 1;
    const currentRsi = finite(rsi[currentIndex]) || finite(quoteByCode.get(code)?.rsi);
    if (!currentRsi) continue;
    const current = series[currentIndex];
    const recent = series.slice(-5).map((row) => row.close);
    const priorLow = priorPivot(series, rsi, currentIndex, "low");
    const priorHigh = priorPivot(series, rsi, currentIndex, "high");
    const meta = latestByCode.get(code) || {};
    const base = {
      code,
      name: meta.name || quoteByCode.get(code)?.name || code,
      market: meta.market || marketName(quoteByCode.get(code)?.exchange),
      sector: meta.sector || quoteByCode.get(code)?.sector || "미분류",
      close: current.close,
      changePct: finite(quoteByCode.get(code)?.changePct),
      rsi: currentRsi,
      date: current.date,
    };
    if (priorLow && current.close < priorLow.close && currentRsi > priorLow.rsi + 1 && current.close <= Math.min(...recent)) {
      bullish.push({
        ...base,
        previousDate: priorLow.date,
        previousPrice: priorLow.close,
        previousRsi: priorLow.rsi,
        priceGapPct: (current.close / priorLow.close - 1) * 100,
        rsiGap: currentRsi - priorLow.rsi,
      });
    }
    if (priorHigh && current.close > priorHigh.close && currentRsi < priorHigh.rsi - 1 && current.close >= Math.max(...recent)) {
      bearish.push({
        ...base,
        previousDate: priorHigh.date,
        previousPrice: priorHigh.close,
        previousRsi: priorHigh.rsi,
        priceGapPct: (current.close / priorHigh.close - 1) * 100,
        rsiGap: currentRsi - priorHigh.rsi,
      });
    }
  }
  bullish.sort((a, b) => b.rsiGap - a.rsiGap || a.priceGapPct - b.priceGapPct);
  bearish.sort((a, b) => a.rsiGap - b.rsiGap || b.priceGapPct - a.priceGapPct);
  return { bullish: bullish.slice(0, 100), bearish: bearish.slice(0, 100) };
}

export function screenTurnover(quotes, latestByCode) {
  return quotes.map((quote) => {
    const meta = latestByCode.get(quote.code) || {};
    const marketCapWon = finite(meta.cap) || finite(quote.marketCap);
    const tradingValueWon = quote.close * quote.volume;
    return {
      code: quote.code,
      name: meta.name || quote.name || quote.code,
      market: meta.market || marketName(quote.exchange),
      sector: meta.sector || quote.sector || "미분류",
      close: quote.close,
      changePct: quote.changePct,
      tradingValueWon,
      marketCapWon,
      turnoverPct: marketCapWon > 0 ? tradingValueWon / marketCapWon * 100 : 0,
      relativeVolume: quote.relativeVolume,
    };
  }).filter((row) => row.marketCapWon >= 100_000_000_000
    && row.tradingValueWon >= 10_000_000_000
    && row.turnoverPct >= 1
    && row.relativeVolume >= 1.5)
    .sort((a, b) => b.turnoverPct - a.turnoverPct || b.tradingValueWon - a.tradingValueWon)
    .slice(0, 100);
}

export function screenAlignmentTransitions(seriesByCode, latestByCode, quotes) {
  const results = [];
  for (const quote of quotes) {
    const series = seriesByCode.get(quote.code) || [];
    if (series.length < 21 || !(quote.sma5 > quote.sma10 && quote.sma10 > quote.sma20)) continue;
    const states = movingAverageStates(series);
    if (!states.length) continue;
    states[states.length - 1] = {
      ...states.at(-1), sma5: quote.sma5, sma10: quote.sma10, sma20: quote.sma20,
      bullish: true, reverse: quote.sma5 < quote.sma10 && quote.sma10 < quote.sma20,
    };
    let onset = states.length - 1;
    while (onset > 0 && states[onset - 1].bullish) onset -= 1;
    const age = states.length - onset;
    if (age > 5) continue;
    const reverseWindow = states.slice(Math.max(0, onset - 20), onset);
    const reverse = [...reverseWindow].reverse().find((state) => state.reverse);
    if (!reverse) continue;
    const meta = latestByCode.get(quote.code) || {};
    results.push({
      code: quote.code,
      name: meta.name || quote.name || quote.code,
      market: meta.market || marketName(quote.exchange),
      sector: meta.sector || quote.sector || "미분류",
      close: quote.close,
      changePct: quote.changePct,
      transitionDate: states[onset].date,
      reverseDate: reverse.date,
      daysSinceTransition: age - 1,
      sma5: quote.sma5,
      sma10: quote.sma10,
      sma20: quote.sma20,
    });
  }
  return results.sort((a, b) => a.daysSinceTransition - b.daysSinceTransition || b.changePct - a.changePct).slice(0, 100);
}

function buildPriceHistory(data, quotes, asOfDate) {
  const seriesByCode = new Map();
  const latestByCode = new Map();
  const rows = [...(data.rows || []), ...(data.liveSnapshot?.rows || [])];
  for (const row of rows) {
    const date = String(row[0] || "");
    const code = String(row[1] || "");
    const close = finite(row[5]);
    if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(code) || close <= 0) continue;
    if (!seriesByCode.has(code)) seriesByCode.set(code, new Map());
    seriesByCode.get(code).set(date, { date, close });
    const existing = latestByCode.get(code);
    if (!existing || date >= existing.date) latestByCode.set(code, {
      date, name: String(row[2] || code), market: String(row[3] || ""), sector: String(row[4] || "미분류"), cap: finite(row[6]),
    });
  }
  for (const quote of quotes) {
    if (!seriesByCode.has(quote.code)) continue;
    if (asOfDate && quote.close > 0) seriesByCode.get(quote.code).set(asOfDate, { date: asOfDate, close: quote.close });
  }
  return {
    latestByCode,
    seriesByCode: new Map([...seriesByCode].map(([code, values]) => [code, [...values.values()].sort((a, b) => a.date.localeCompare(b.date))])),
  };
}

function movingAverageStates(series) {
  const closes = series.map((row) => row.close);
  const states = [];
  for (let index = 19; index < series.length; index += 1) {
    const sma5 = average(closes.slice(index - 4, index + 1));
    const sma10 = average(closes.slice(index - 9, index + 1));
    const sma20 = average(closes.slice(index - 19, index + 1));
    states.push({
      date: series[index].date, sma5, sma10, sma20,
      bullish: sma5 > sma10 && sma10 > sma20,
      reverse: sma5 < sma10 && sma10 < sma20,
    });
  }
  return states;
}

function priorPivot(series, rsi, currentIndex, type) {
  const lower = Math.max(15, currentIndex - 30);
  for (let index = currentIndex - 3; index >= lower; index -= 1) {
    if (!finite(rsi[index])) continue;
    const window = series.slice(index - 2, index + 3).map((row) => row.close);
    const pivot = type === "low" ? Math.min(...window) : Math.max(...window);
    if (series[index].close === pivot) return { ...series[index], rsi: rsi[index] };
  }
  return null;
}

async function fetchKoreaScanner(fetchImpl) {
  const response = await fetchImpl("https://scanner.tradingview.com/korea/scan", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 Stock Flow Technical Scanner" },
    body: JSON.stringify({
      filter: [
        { left: "type", operation: "equal", right: "stock" },
        { left: "active_symbol", operation: "equal", right: true },
      ],
      options: { lang: "en" },
      symbols: { query: { types: [] }, tickers: [] },
      columns: SCANNER_COLUMNS,
      sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
      range: [0, 5000],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`한국 보조지표 스캐너 HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.data) || payload.data.length < 1000) throw new Error("한국 보조지표 스캐너 응답 종목 수가 비정상적입니다.");
  return payload.data;
}

function normalizeScannerRow(row) {
  const [ticker, name, close, changePct, volume, relativeVolume, marketCap, sma5, sma10, sma20, rsi, sector, exchange] = row.d || row.values || [];
  const code = String(ticker || row.s?.split(":").at(-1) || "");
  if (!/^\d{6}$/.test(code) || finite(close) <= 0) return null;
  return {
    code, name: String(name || code), close: finite(close), changePct: finite(changePct), volume: finite(volume),
    relativeVolume: finite(relativeVolume), marketCap: finite(marketCap), sma5: finite(sma5), sma10: finite(sma10),
    sma20: finite(sma20), rsi: finite(rsi), sector: String(sector || "미분류"), exchange: String(exchange || ""),
  };
}

function parseDashboardFile(source) {
  const separator = source.indexOf("=");
  if (separator < 0) throw new Error("대시보드 데이터 파일 형식이 올바르지 않습니다.");
  return JSON.parse(source.slice(separator + 1).replace(/;\s*$/, ""));
}

function rsiValue(gain, loss) {
  if (loss === 0) return gain === 0 ? 50 : 100;
  if (gain === 0) return 0;
  return 100 - 100 / (1 + gain / loss);
}

function average(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
function marketName(exchange) { return String(exchange).toUpperCase().includes("KOSDAQ") ? "코스닥" : "코스피"; }
