import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SCANNER_URL = "https://scanner.tradingview.com/korea/scan";
const SCANNER_COLUMNS = [
  "name", "description", "close", "change", "volume", "market_cap_basic",
  "sector", "exchange", "high", "price_52_week_high",
];

export async function refreshMarketRankings(_client, config, options = {}) {
  const path = resolve(config.dashboardDataFile);
  const data = parseDashboardFile(readFileSync(path, "utf8"));
  const historyByCode = buildHistoryByCode(data);
  const scannerRows = options.scannerRows || await fetchKoreaScanner(options.fetchImpl || fetch);
  const quotes = scannerRows
    .map((row) => normalizeScannerRow(row, historyByCode))
    .filter(Boolean);
  await correctCorporateActionChanges(quotes, _client, options);
  const latestDate = String(data.liveSnapshot?.date || [...(data.dates || [])].sort().at(-1) || "");

  const byMarket = (market) => quotes.filter((row) => row.market === market);
  const high52 = (market) => byMarket(market)
    .filter((row) => row.volume > 0
      && !row.corporateActionAdjusted
      && !(row.corporateActionSuspected && !row.officialHigh52Verified)
      && row.high52 > 0
      && row.dayHigh >= row.high52 - Math.max(0.01, row.high52 * 1e-8)
      && Math.abs(row.changePct) >= 0.005)
    .sort((a, b) => b.changePct - a.changePct || b.marketCapWon - a.marketCapWon);
  const daily = (market, direction) => byMarket(market)
    .filter((row) => row.volume > 0 && (direction > 0 ? row.changePct > 0.005 : row.changePct < -0.005))
    .sort((a, b) => direction > 0
      ? b.changePct - a.changePct || b.marketCapWon - a.marketCapWon
      : a.changePct - b.changePct || b.marketCapWon - a.marketCapWon)
    .slice(0, 100);

  data.marketRanks = {
    updatedAt: new Date().toISOString(),
    asOfDate: latestDate,
    source: "all-market-daily-quotes",
    high52: {
      kospi: high52("KOSPI"),
      kosdaq: high52("KOSDAQ"),
    },
    dailyChange: {
      kospi: { rise: daily("KOSPI", 1), fall: daily("KOSPI", -1) },
      kosdaq: { rise: daily("KOSDAQ", 1), fall: daily("KOSDAQ", -1) },
    },
    officialCorrections: quotes
      .filter((row) => row.corporateActionAdjusted)
      .map((row) => ({ code: row.code, date: latestDate, changePct: row.changePct })),
  };
  writeFileSync(path, `window.FLOW_DASHBOARD_DATA=${JSON.stringify(data)};\n`, "utf8");
  return {
    kospi: data.marketRanks.high52.kospi.length,
    kosdaq: data.marketRanks.high52.kosdaq.length,
    quotes: quotes.length,
  };
}

function buildHistoryByCode(data) {
  const historyByCode = new Map();
  for (const row of [...(data.rows || []), ...(data.liveSnapshot?.rows || [])]) {
    const code = String(row[1] || "");
    if (!/^\d{6}$/.test(code)) continue;
    if (!historyByCode.has(code)) historyByCode.set(code, []);
    historyByCode.get(code).push(row);
  }
  for (const rows of historyByCode.values()) {
    rows.sort((a, b) => String(b[0]).localeCompare(String(a[0])));
  }
  return historyByCode;
}

function normalizeScannerRow(row, historyByCode) {
  const values = row.d || row.values || [];
  const [ticker, _description, close, changePct, volume, marketCap, _sector, _exchange, dayHigh, high52] = values;
  const code = String(ticker || row.s?.split(":").at(-1) || "");
  const latest = historyByCode.get(code)?.[0];
  if (!latest || !/^\d{6}$/.test(code)) return null;
  const market = latest[3] === "유가" ? "KOSPI" : latest[3] === "코스닥" ? "KOSDAQ" : "";
  if (!market) return null;
  const scannerMarketCapWon = numeric(marketCap);
  const referenceMarketCapWon = numeric(latest[6]);
  return {
    code,
    name: String(latest[2] || code),
    market,
    close: numeric(close) || numeric(latest[5]),
    changePct: latest[14] == null ? numeric(changePct) : numeric(latest[14]),
    hasOfficialChange: latest[14] != null,
    volume: numeric(volume),
    dayHigh: numeric(dayHigh),
    high52: numeric(high52),
    marketCapWon: scannerMarketCapWon || referenceMarketCapWon,
    corporateActionSuspected: scannerMarketCapWon > 0
      && referenceMarketCapWon > 0
      && Math.abs(scannerMarketCapWon / referenceMarketCapWon - 1) > 0.35,
    sector: String(latest[4] || "미분류"),
  };
}

async function correctCorporateActionChanges(quotes, client, options) {
  const isHigh52Candidate = (row) => row.high52 > 0
    && row.dayHigh >= row.high52 - Math.max(0.01, row.high52 * 1e-8);
  const targets = quotes.filter((row) => isHigh52Candidate(row)
    || (!row.hasOfficialChange && Math.abs(row.changePct) >= 29));
  if (!targets.length) return;
  const resolveQuote = options.quoteResolver || (client?.currentPrice
    ? async (row) => {
      const payload = await client.currentPrice(row.code);
      const quote = payload.output || {};
      return {
        changePct: numeric(quote.prdy_ctrt),
        close: numeric(quote.stck_prpr),
        volume: numeric(quote.acml_vol),
        dayHigh: numeric(quote.stck_hgpr),
        high52: numeric(quote.d250_hgpr),
      };
    }
    : (row) => fetchNaverQuote(row.code, options.fetchImpl || fetch));
  let index = 0;
  const workers = Array.from({ length: Math.min(4, targets.length) }, async () => {
    while (true) {
      const target = targets[index++];
      if (!target) return;
      try {
        const quote = await resolveQuote(target);
        if (!quote || !Number.isFinite(Number(quote.changePct))) continue;
        const scannerChangePct = target.changePct;
        const scannerHigh52 = target.high52;
        target.changePct = Number(quote.changePct);
        const officialHigh52 = numeric(quote.high52);
        target.officialHigh52Verified = officialHigh52 > 0;
        target.corporateActionAdjusted = Math.abs(scannerChangePct - target.changePct) > 5
          || (officialHigh52 > 0
            && Math.abs(scannerHigh52 - officialHigh52) > Math.max(1, officialHigh52 * 0.01));
        if (numeric(quote.close) > 0) target.close = numeric(quote.close);
        if (quote.volume != null) target.volume = numeric(quote.volume);
        if (numeric(quote.dayHigh) > 0) target.dayHigh = numeric(quote.dayHigh);
        if (officialHigh52 > 0) target.high52 = officialHigh52;
        target.hasOfficialChange = true;
      } catch (error) {
        console.warn(`Official daily change lookup failed [${target.code}]: ${error.message}`);
      }
    }
  });
  await Promise.all(workers);
}

async function fetchNaverQuote(code, fetchImpl) {
  const response = await fetchImpl(`https://m.stock.naver.com/api/stock/${code}/basic`, {
    headers: { "user-agent": "Mozilla/5.0 Stock Flow Market Scanner" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const comparison = payload.compareToPreviousPrice || {};
  const falling = ["4", "5"].includes(String(comparison.code))
    || /FALL|하락/i.test(`${comparison.name || ""} ${comparison.text || ""}`);
  const rawChangePct = numeric(payload.fluctuationsRatio);
  return {
    changePct: rawChangePct < 0 ? rawChangePct : rawChangePct * (falling ? -1 : 1),
    close: numeric(payload.closePrice),
  };
}

async function fetchKoreaScanner(fetchImpl) {
  const response = await fetchImpl(SCANNER_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 Stock Flow Market Scanner" },
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
  if (!response.ok) throw new Error(`한국 전종목 시세 조회 실패: HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.data) || payload.data.length < 1000) {
    throw new Error("한국 전종목 시세 응답 종목 수가 비정상적입니다.");
  }
  return payload.data;
}

function parseDashboardFile(source) {
  const separator = source.indexOf("=");
  if (separator < 0) throw new Error("대시보드 데이터 파일 형식이 올바르지 않습니다.");
  return JSON.parse(source.slice(separator + 1).replace(/;\s*$/, ""));
}

function numeric(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
