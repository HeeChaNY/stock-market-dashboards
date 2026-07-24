import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MIN_MARKET_CAP_USD = 10_000_000_000;
const NEWS_MATCHER_VERSION = 5;
const SCANNER_COLUMNS = [
  "name", "description", "close", "change", "market_cap_basic",
  "price_earnings_ttm", "price_book_ratio", "sector", "high", "low",
  "high|1", "low|1", "High.3M", "Low.3M", "price_52_week_high",
  "price_52_week_low", "currency", "exchange",
];

const MARKETS = [
  { id: "us", name: "미국", scanner: "america", currency: "USD", usdLocal: 1 },
  { id: "hk", name: "홍콩", scanner: "hongkong", currency: "HKD", fxSymbol: "FX_IDC:USDHKD" },
  { id: "cn", name: "중국A", scanner: "china", currency: "CNY", fxSymbol: "FX_IDC:USDCNY" },
  { id: "jp", name: "일본", scanner: "japan", currency: "JPY", fxSymbol: "FX_IDC:USDJPY" },
];

const INDEXES = [
  { market: "us", symbol: "SP:SPX", name: "S&P 500" },
  { market: "us", symbol: "NASDAQ:NDX", name: "나스닥 100" },
  { market: "hk", symbol: "TVC:HSI", name: "항셍" },
  { market: "cn", symbol: "SSE:000001", name: "상하이종합" },
  { market: "cn", symbol: "SZSE:399001", name: "선전성분" },
  { market: "jp", symbol: "TVC:NI225", name: "닛케이 225" },
  { market: "jp", symbol: "TSE:TOPIX", name: "TOPIX" },
];

const SECTOR_ETFS = [
  ...[
    ["AMEX:XLC", "커뮤니케이션"], ["AMEX:XLY", "경기소비재"], ["AMEX:XLF", "금융"],
    ["AMEX:XLRE", "리츠"], ["AMEX:XLP", "필수소비재"], ["AMEX:XLV", "헬스케어"],
    ["AMEX:XLI", "산업재"], ["AMEX:XLB", "소재"], ["AMEX:XLE", "에너지"],
    ["AMEX:XLU", "유틸리티"], ["AMEX:XLK", "테크"],
  ].map(([symbol, sector]) => ({ market: "us", symbol, sector })),
  ...[
    ["HKEX:3033", "항셍테크"], ["HKEX:2828", "H주(중국기업)"], ["HKEX:2800", "항셍지수"],
    ["HKEX:3067", "항셍테크 2배"],
  ].map(([symbol, sector]) => ({ market: "hk", symbol, sector })),
  ...[
    ["SZSE:159928", "소비"], ["SSE:512200", "부동산"], ["SSE:512690", "백주(주류)"],
    ["SSE:512010", "의약"], ["SSE:512400", "유색금속"], ["SSE:512800", "은행"],
    ["SSE:515030", "신에너지차"], ["SSE:512880", "증권"], ["SSE:512660", "방산"],
    ["SSE:515790", "태양광"], ["SSE:515050", "5G통신"], ["SSE:515000", "테크"],
    ["SSE:512480", "반도체"],
  ].map(([symbol, sector]) => ({ market: "cn", symbol, sector })),
  ...[
    ["TSE:1615", "은행"], ["TSE:1617", "식품"], ["TSE:1618", "에너지"],
    ["TSE:1619", "건설·소재"], ["TSE:1620", "화학"], ["TSE:1621", "의약"],
    ["TSE:1622", "자동차·운송장비"], ["TSE:1623", "철강·비철"], ["TSE:1624", "기계"],
    ["TSE:1625", "전기·정밀"], ["TSE:1626", "IT·서비스"], ["TSE:1627", "전력·가스"],
    ["TSE:1628", "운송·물류"], ["TSE:1629", "상사·도매"], ["TSE:1630", "소매"],
    ["TSE:1631", "은행"], ["TSE:1632", "금융(은행 제외)"], ["TSE:1633", "부동산"],
  ].map(([symbol, sector]) => ({ market: "jp", symbol, sector })),
];

const ETF_COLUMNS = ["name", "description", "close", "change", "Perf.W", "Perf.1M", "Perf.3M", "Perf.6M", "Perf.YTD", "Perf.Y", "Perf.3Y", "Perf.5Y"];
const INDEX_COLUMNS = ["name", "description", "close", "change", "change_abs", "currency"];

export async function refreshGlobalMarkets(config, { onProgress } = {}) {
  const outputPath = resolve(config.globalMarketDataFile || "./data/global-market.json");
  const previous = readJson(outputPath);
  const generatedAt = new Date().toISOString();
  const date = koreaDate(generatedAt);
  const progress = (phase, completed, total, label) => onProgress?.({ phase, completed, total, label });

  progress("fx", 0, 8, "환율 기준 확인");
  const fxRows = await scanSymbols(MARKETS.filter((market) => market.fxSymbol).map((market) => market.fxSymbol), ["close"]);
  const fxMap = Object.fromEntries(fxRows.map((row) => [row.symbol, finite(row.values[0]) || 1]));
  progress("fx", 1, 8, "시장 유니버스 조회");

  let completedMarkets = 0;
  const universeResults = await Promise.all(MARKETS.map(async (market) => {
    const usdLocal = market.usdLocal || fxMap[market.fxSymbol] || fallbackFx(market.currency);
    const rows = await scanUniverse(market, MIN_MARKET_CAP_USD * usdLocal);
    completedMarkets += 1;
    progress("universe", completedMarkets + 1, 8, `${market.name} ${rows.length.toLocaleString()}종목`);
    return { market: { ...market, usdLocal }, rows };
  }));

  progress("benchmarks", 6, 8, "지수·섹터 ETF 조회");
  const [indexRows, etfRows] = await Promise.all([
    scanSymbols(INDEXES.map((item) => item.symbol), INDEX_COLUMNS),
    scanSymbols(SECTOR_ETFS.map((item) => item.symbol), ETF_COLUMNS),
  ]);

  const previousSignals = new Map((previous?.stocks || []).map((row) => [`${row.symbol}:${row.signal}`, row]));
  const stocks = [];
  const universes = [];
  const marketSummaries = [];

  for (const { market, rows } of universeResults) {
    const normalized = rows.map((row) => normalizeStock(row, market)).filter(Boolean);
    universes.push(...normalized);
    for (const stock of normalized) {
      // 표시 등락률이 0.00%인 종목은 거래정지·장기 무변동 종목일 가능성이 높아
      // 신고가와 신저가 양쪽 스캔에서 제외한다.
      if (Math.abs(stock.changePct) < 0.005) continue;
      const signals = detectSignals(stock);
      for (const signal of signals) {
        const key = `${stock.symbol}:${signal.signal}`;
        const prior = previousSignals.get(key);
        const firstSeenDate = prior?.firstSeenDate || date;
        const newDate = prior?.newByPrice
          ? (prior.newDate || prior.firstSeenDate || date)
          : (signal.newByPrice ? date : null);
        stocks.push({
          ...stock,
          ...signal,
          firstSeenDate,
          newDate,
          isNew: newDate === date,
        });
      }
    }
    const own = stocks.filter((row) => row.market === market.id);
    const indexes = INDEXES.filter((item) => item.market === market.id).map((item) => {
      const found = indexRows.find((row) => row.symbol === item.symbol);
      return found ? normalizeIndex(found, item) : { ...item, error: "데이터 없음" };
    });
    marketSummaries.push({
      id: market.id,
      name: market.name,
      universeCount: normalized.length,
      high60: own.filter((row) => row.signal === "high").length,
      low60: own.filter((row) => row.signal === "low").length,
      newHigh: own.filter((row) => row.signal === "high" && row.isNew).length,
      newLow: own.filter((row) => row.signal === "low" && row.isNew).length,
      high52: own.filter((row) => row.signal === "high" && row.hit52).length,
      low52: own.filter((row) => row.signal === "low" && row.hit52).length,
      indexes,
    });
  }

  progress("news", 7, 8, `종목 관련 뉴스 확인 0/${stocks.length}`);
  await enrichStockNews(stocks, previous?.stocks || [], generatedAt, ({ completed, total }) => {
    if (completed === total || completed % 20 === 0) progress("news", 7, 8, `종목 관련 뉴스 확인 ${completed}/${total}`);
  });

  const sectors = buildSectorRows(universes, stocks);
  const etfs = etfRows.map((row) => normalizeEtf(row, SECTOR_ETFS.find((item) => item.symbol === row.symbol))).filter(Boolean);
  const summary = buildNarrative(marketSummaries, sectors);
  const payload = {
    generatedAt,
    date,
    source: "TradingView Scanner · Google News RSS",
    methodology: { minimumMarketCapUsd: MIN_MARKET_CAP_USD, primaryWindow: "약 60거래일(3개월)", longWindow: "52주" },
    summary,
    commentary: buildCommentary(summary, marketSummaries, sectors, stocks),
    markets: marketSummaries,
    stocks: stocks.sort(stockSort),
    sectors,
    etfs,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");
  progress("done", 8, 8, "완료");
  return payload;
}

export function formatGlobalTelegram(payload) {
  const lines = [`🌏 글로벌 증시 동향 — ${payload.date}`, payload.summary, ""];
  for (const market of payload.markets) {
    const indexText = market.indexes.map((item) => `${item.name} ${signed(item.changePct, 2)}%`).join(" · ");
    lines.push(`${market.name}  신고 ${market.high60} (NEW ${market.newHigh}) · 신저 ${market.low60} (NEW ${market.newLow})`);
    if (indexText) lines.push(`  ${indexText}`);
  }
  const strong = payload.sectors.filter((row) => row.netStrength > 0).slice(0, 3).map((row) => `${row.marketName} ${translateSector(row.sector)} +${row.netStrength}`);
  const weak = [...payload.sectors].sort((a, b) => a.netStrength - b.netStrength).filter((row) => row.netStrength < 0).slice(0, 3).map((row) => `${row.marketName} ${translateSector(row.sector)} ${row.netStrength}`);
  if (strong.length) lines.push("", `강세 섹터: ${strong.join(" · ")}`);
  if (weak.length) lines.push(`약세 섹터: ${weak.join(" · ")}`);
  return lines.join("\n");
}

async function scanUniverse(market, threshold) {
  const body = {
    filter: [
      { left: "type", operation: "equal", right: "stock" },
      { left: "typespecs", operation: "has", right: "common" },
      { left: "market_cap_basic", operation: "egreater", right: threshold },
      { left: "active_symbol", operation: "equal", right: true },
    ],
    options: { lang: "en" },
    symbols: { query: { types: [] }, tickers: [] },
    columns: SCANNER_COLUMNS,
    sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
    range: [0, 5000],
  };
  const payload = await scannerRequest(`https://scanner.tradingview.com/${market.scanner}/scan`, body);
  return (payload.data || []).map(scannerRow);
}

async function scanSymbols(tickers, columns) {
  if (!tickers.length) return [];
  const payload = await scannerRequest("https://scanner.tradingview.com/global/scan", {
    symbols: { tickers, query: { types: [] } }, columns,
  });
  return (payload.data || []).map(scannerRow);
}

async function scannerRequest(url, body, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 Stock Flow Global Scanner" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 800));
    }
  }
  throw new Error(`글로벌 스캐너 조회 실패: ${lastError?.message || lastError}`);
}

function scannerRow(row) {
  return { symbol: row.s, values: row.d || [] };
}

function normalizeStock(row, market) {
  const [ticker, name, close, changePct, marketCap, per, pbr, sector, high, low, priorHigh, priorLow, high60, low60, high52, low52, currency, exchange] = row.values;
  if (![close, marketCap, high, low, high60, low60].every((value) => Number.isFinite(Number(value)))) return null;
  return {
    market: market.id,
    marketName: market.name,
    symbol: row.symbol,
    ticker: String(ticker || row.symbol.split(":").at(-1)),
    name: String(name || ticker || row.symbol),
    exchange: String(exchange || row.symbol.split(":")[0]),
    currency: String(currency || market.currency),
    sector: String(sector || "기타"),
    close: finite(close),
    changePct: finite(changePct),
    marketCapUsd: finite(marketCap) / market.usdLocal,
    per: nullableNumber(per),
    pbr: nullableNumber(pbr),
    high: finite(high), low: finite(low), priorHigh: finite(priorHigh), priorLow: finite(priorLow),
    high60: finite(high60), low60: finite(low60), high52: finite(high52), low52: finite(low52),
  };
}

function detectSignals(stock) {
  const epsilon = Math.max(Math.abs(stock.close) * 1e-6, 1e-8);
  const rows = [];
  if (stock.high >= stock.high60 - epsilon) rows.push({ signal: "high", hit52: stock.high52 > 0 && stock.high >= stock.high52 - epsilon, newByPrice: stock.high > stock.priorHigh + epsilon });
  if (stock.low <= stock.low60 + epsilon) rows.push({ signal: "low", hit52: stock.low52 > 0 && stock.low <= stock.low52 + epsilon, newByPrice: stock.low < stock.priorLow - epsilon });
  return rows;
}

async function enrichStockNews(stocks, previousRows, generatedAt, onProgress) {
  const previousBySymbol = new Map();
  for (const row of previousRows) if (!previousBySymbol.has(row.symbol)) previousBySymbol.set(row.symbol, row);
  const currentBySymbol = new Map();
  for (const row of stocks) if (!currentBySymbol.has(row.symbol)) currentBySymbol.set(row.symbol, row);
  const results = new Map();
  const jobs = [];
  const cacheCutoff = Date.parse(generatedAt) - 6 * 60 * 60 * 1000;

  for (const [symbol, stock] of currentBySymbol) {
    const cached = previousBySymbol.get(symbol);
    if (cached?.reasonMatcherVersion === NEWS_MATCHER_VERSION && cached?.reasonFetchedAt && Date.parse(cached.reasonFetchedAt) >= cacheCutoff && ["news", "none"].includes(cached.reasonType)) {
      results.set(symbol, newsFields(cached));
    } else {
      jobs.push(stock);
    }
  }

  let completed = currentBySymbol.size - jobs.length;
  onProgress?.({ completed, total: currentBySymbol.size });
  await mapConcurrent(jobs, 8, async (stock) => {
    const news = await queryCompanyNews(stock).catch(() => null);
    results.set(stock.symbol, news ? {
      reason: news.title,
      reasonOriginal: news.originalTitle,
      reasonLanguage: news.language,
      reasonType: "news",
      reasonUrl: news.url,
      reasonSource: news.source,
      reasonPublishedAt: news.publishedAt,
      reasonFetchedAt: generatedAt,
      reasonMatcherVersion: NEWS_MATCHER_VERSION,
    } : {
      reason: "관련 최신 뉴스 미포착",
      reasonOriginal: null,
      reasonLanguage: "ko",
      reasonType: "none",
      reasonUrl: null,
      reasonSource: null,
      reasonPublishedAt: null,
      reasonFetchedAt: generatedAt,
      reasonMatcherVersion: NEWS_MATCHER_VERSION,
    });
    completed += 1;
    onProgress?.({ completed, total: currentBySymbol.size });
  });

  for (const stock of stocks) Object.assign(stock, results.get(stock.symbol));
}

async function queryCompanyNews(stock) {
  const company = cleanCompanyName(stock.name);
  const query = `"${company}" when:7d`;
  const params = new URLSearchParams({ q: query, hl: "en-US", gl: "US", ceid: "US:en" });
  const response = await fetch(`https://news.google.com/rss/search?${params}`, {
    headers: { "user-agent": "Mozilla/5.0 Stock Flow Global News" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`뉴스 HTTP ${response.status}`);
  const items = parseNewsRss(await response.text());
  const terms = relevanceTerms(company, stock.ticker);
  const relevant = items.find((item) => terms.some((term) => normalizeText(item.title).includes(term)) && isMaterialHeadline(item.title));
  if (!relevant) return null;
  const originalTitle = stripPublisher(relevant.title, relevant.source);
  const translatedTitle = await translateHeadlineToKorean(originalTitle);
  return {
    ...relevant,
    title: translatedTitle,
    originalTitle,
    language: "ko",
  };
}

async function translateHeadlineToKorean(title) {
  const source = String(title || "").trim();
  if (!source || /[가-힣]/.test(source)) return source;
  // Google News RSS is requested in en-US, so fixing the source language to
  // English avoids company names making short headlines look untranslated.
  const params = new URLSearchParams({ client: "gtx", sl: "en", tl: "ko", dt: "t", q: source });
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`https://translate.googleapis.com/translate_a/single?${params}`, {
        headers: { "user-agent": "Mozilla/5.0 Stock Flow Global News" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`번역 HTTP ${response.status}`);
      const payload = await response.json();
      const translated = Array.isArray(payload?.[0])
        ? payload[0].map((part) => String(part?.[0] || "")).join("").trim()
        : "";
      if (translated && /[가-힣]/.test(translated)) return translated;
      throw new Error("빈 번역 결과");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("뉴스 제목 번역 실패");
}

function parseNewsRss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 15).map((match) => {
    const item = match[1];
    const title = xmlValue(item, "title");
    const url = xmlValue(item, "link");
    const sourceMatch = item.match(/<source(?:\s[^>]*)?>([\s\S]*?)<\/source>/i);
    const source = decodeXml(sourceMatch?.[1] || "Google News");
    const published = xmlValue(item, "pubDate");
    const parsed = Date.parse(published);
    return { title, url, source, publishedAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null };
  }).filter((item) => item.title && item.url);
}

function xmlValue(value, tag) {
  const match = value.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeXml(String(match?.[1] || "").replace(/^<!\[CDATA\[|\]\]>$/g, ""));
}

function decodeXml(value) {
  return String(value)
    .replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function cleanCompanyName(value) {
  return String(value || "")
    .replace(/\b(class\s+[a-z]|incorporated|corporation|company|holdings?|limited|ltd\.?|inc\.?|corp\.?|co\.?|plc|sa|ag|nv)\b/gi, " ")
    .replace(/[(),]/g, " ").replace(/\s+/g, " ").trim() || String(value || "");
}

function relevanceTerms(company, ticker) {
  const ignored = new Set(["group", "bank", "motor", "financial", "international", "technology", "technologies", "industrial", "industries", "services", "screen", "digital", "power", "energy", "national", "global", "united", "general"]);
  const normalizedCompany = normalizeText(company);
  const companyTokens = normalizedCompany.split(" ").filter(Boolean);
  const tokens = companyTokens.filter((token) => token.length >= 5 && !ignored.has(token));
  if (companyTokens.length >= 2) tokens.push(normalizedCompany);
  const tickerText = String(ticker || "").toLowerCase();
  if (/[a-z]/.test(tickerText) && tickerText.length >= 2) tokens.push(tickerText);
  return [...new Set(tokens)].sort((a, b) => b.length - a.length).slice(0, 5);
}

function normalizeText(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

function isMaterialHeadline(title) {
  return /\b(stock|shares?|earnings?|revenue|sales|profit|loss|guidance|forecast|outlook|price\s*target|prices?|upgrade|downgrade|rating|acqui(?:re|res|red|sition)|merger|deal|offer(?:ing)?|buyback|dividend|investment|funding|contract|order|partnership|joint\s+venture|lawsuit|probe|investigation|regulat(?:or|ory)|approval|patent|trial|drug|tariff|export|production|shipment|launch(?:es|ed)?|introduc(?:es|ed)|unveil(?:s|ed)|appoint(?:s|ed)?|ceo|cfo|restructur|layoff|bankrupt|default|debt|bond|ipo|market\s+cap|index|outsourc|fine|penalt|settlement|recall)\b/i.test(String(title || ""));
}

function stripPublisher(title, source) {
  const suffix = ` - ${source}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}

function newsFields(row) {
  return {
    reason: row.reason || "관련 최신 뉴스 미포착",
    reasonOriginal: row.reasonOriginal || null,
    reasonLanguage: row.reasonLanguage || null,
    reasonType: row.reasonType || "none",
    reasonUrl: row.reasonUrl || null,
    reasonSource: row.reasonSource || null,
    reasonPublishedAt: row.reasonPublishedAt || null,
    reasonFetchedAt: row.reasonFetchedAt || null,
    reasonMatcherVersion: row.reasonMatcherVersion || null,
  };
}

async function mapConcurrent(items, concurrency, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  }));
}

function normalizeIndex(row, item) {
  const [, , close, changePct, changeAbs, currency] = row.values;
  return { ...item, close: finite(close), changePct: finite(changePct), changeAbs: finite(changeAbs), currency: currency || null };
}

function normalizeEtf(row, meta) {
  if (!meta) return null;
  const [ticker, name, close, d1, w1, m1, m3, m6, ytd, y1, y3, y5] = row.values;
  return {
    ...meta,
    ticker: String(ticker || row.symbol.split(":").at(-1)),
    name: String(name || meta.sector),
    close: finite(close),
    returns: { d1: nullableNumber(d1), w1: nullableNumber(w1), m1: nullableNumber(m1), m3: nullableNumber(m3), m6: nullableNumber(m6), ytd: nullableNumber(ytd), y1: nullableNumber(y1), y3: nullableNumber(y3), y5: nullableNumber(y5) },
  };
}

function buildSectorRows(universes, signals) {
  const groups = new Map();
  for (const stock of universes) {
    const key = `${stock.market}:${stock.sector}`;
    const group = groups.get(key) || { market: stock.market, marketName: stock.marketName, sector: stock.sector, universe: 0, perValues: [], pbrValues: [] };
    group.universe += 1;
    if (stock.per > 0 && stock.per < 500) group.perValues.push(stock.per);
    if (stock.pbr > 0 && stock.pbr < 100) group.pbrValues.push(stock.pbr);
    groups.set(key, group);
  }
  for (const signal of signals) {
    const group = groups.get(`${signal.market}:${signal.sector}`);
    if (!group) continue;
    if (signal.signal === "high") group.high = (group.high || 0) + 1;
    else group.low = (group.low || 0) + 1;
  }
  return [...groups.values()].map((group) => {
    const high = group.high || 0;
    const low = group.low || 0;
    const netStrength = high - low;
    return {
      market: group.market, marketName: group.marketName, sector: group.sector, universe: group.universe,
      high, low, netStrength, verdict: netStrength >= 2 ? "강세" : netStrength <= -2 ? "약세" : netStrength ? "미세 우위" : "중립",
      per: median(group.perValues), pbr: median(group.pbrValues),
    };
  }).sort((a, b) => b.netStrength - a.netStrength || b.high - a.high || a.low - b.low);
}

function buildNarrative(markets, sectors) {
  const leaders = [...markets].sort((a, b) => (b.high60 - b.low60) - (a.high60 - a.low60));
  const leader = leaders[0];
  const laggard = leaders.at(-1);
  const strong = sectors.find((row) => row.netStrength >= 2);
  const weak = [...sectors].reverse().find((row) => row.netStrength <= -2);
  const pieces = [`${leader.name}은 신고 ${leader.high60} 대 신저 ${leader.low60}로 상대 강도가 가장 높습니다.`];
  if (laggard.id !== leader.id) pieces.push(`${laggard.name}은 신고 ${laggard.high60} 대 신저 ${laggard.low60}로 상대적으로 약합니다.`);
  if (strong) pieces.push(`강세 중심은 ${strong.marketName} ${translateSector(strong.sector)}(+${strong.netStrength})입니다.`);
  if (weak) pieces.push(`약세 중심은 ${weak.marketName} ${translateSector(weak.sector)}(${weak.netStrength})입니다.`);
  return pieces.join(" ");
}

function buildCommentary(summary, markets, sectors, stocks) {
  const byId = Object.fromEntries(markets.map((market) => [market.id, market]));
  const detail = (ids) => ids.map((id) => marketComment(byId[id], sectors, stocks)).filter(Boolean).join(" ");
  return [
    { label: "결론", text: summary },
    { label: "美", text: detail(["us"]) },
    { label: "日", text: detail(["jp"]) },
    { label: "中·홍콩", text: detail(["cn", "hk"]) },
    { label: "체크", text: "신규 신고·신저 진입의 다음 거래일 지속 여부와 지수 등락 대비 개별 종목·섹터 확산 정도를 함께 확인하세요." },
  ];
}

function marketComment(market, sectors, stocks) {
  if (!market) return "";
  const indexText = (market.indexes || []).filter((item) => Number.isFinite(Number(item.changePct)))
    .map((item) => `${item.name} ${signed(item.changePct, 2)}%`).join("·");
  const ownSectors = sectors.filter((row) => row.market === market.id);
  const strong = [...ownSectors].sort((a, b) => b.netStrength - a.netStrength)[0];
  const weak = [...ownSectors].sort((a, b) => a.netStrength - b.netStrength)[0];
  const notable = stocks.find((row) => row.market === market.id && row.reasonType === "news" && row.reason);
  const pieces = [
    indexText,
    `신고 ${market.high60}·신저 ${market.low60}(NEW ${market.newHigh + market.newLow})`,
  ].filter(Boolean);
  if (strong?.netStrength > 0) pieces.push(`강세 ${translateSector(strong.sector)} +${strong.netStrength}`);
  if (weak?.netStrength < 0) pieces.push(`약세 ${translateSector(weak.sector)} ${weak.netStrength}`);
  if (notable) pieces.push(`${notable.ticker}: ${notable.reason}`);
  return `${market.name} ${pieces.join(" — ")}.`;
}

function readJson(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; } catch { return null; }
}

function stockSort(a, b) {
  if (a.market !== b.market) return MARKETS.findIndex((m) => m.id === a.market) - MARKETS.findIndex((m) => m.id === b.market);
  if (a.signal !== b.signal) return a.signal === "high" ? -1 : 1;
  return a.signal === "high" ? b.changePct - a.changePct : a.changePct - b.changePct;
}

function fallbackFx(currency) { return ({ HKD: 7.8, CNY: 7.2, JPY: 155 }[currency] || 1); }
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
function nullableNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function median(values) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function signed(value, digits = 1) { const number = finite(value); return `${number > 0 ? "+" : ""}${number.toFixed(digits)}`; }
function koreaDate(value) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }

const SECTOR_KO = {
  "Electronic Technology": "전자기술", "Technology Services": "기술서비스", "Commercial Services": "상업서비스",
  Finance: "금융", "Health Technology": "헬스케어", "Consumer Services": "소비자서비스", "Consumer Durables": "내구소비재",
  "Consumer Non-Durables": "비내구소비재", "Process Industries": "공정산업", "Producer Manufacturing": "생산재",
  "Industrial Services": "산업서비스", "Energy Minerals": "에너지", "Non-Energy Minerals": "소재", Utilities: "유틸리티",
  Transportation: "운송", "Retail Trade": "소매", Communications: "통신", "Distribution Services": "유통", Miscellaneous: "기타",
};
function translateSector(value) { return SECTOR_KO[value] || value || "기타"; }
