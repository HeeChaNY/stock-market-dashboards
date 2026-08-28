import { readJson, writeJson } from "./store.mjs";

const KRX_LIST_URL = "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13";
const DEFAULT_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000];
const DEFAULT_STALE_CACHE_DAYS = 14;

export async function loadKrxMaster(cacheFile, options = {}) {
  const cached = readJson(cacheFile);
  if (cached?.updatedDate === koreaDate() && isValidMaster(cached.stocks)) {
    return cached.stocks;
  }

  const fetchImpl = options.fetchImpl || fetch;
  const retryDelaysMs = options.retryDelaysMs || DEFAULT_RETRY_DELAYS_MS;
  const sleepImpl = options.sleepImpl || sleep;
  const logger = options.logger || console;
  const attempts = retryDelaysMs.length + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const stocks = await fetchKrxMaster(fetchImpl, options.timeoutMs || 30_000);
      writeJson(cacheFile, { updatedDate: koreaDate(), stocks });
      return stocks;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      const delayMs = retryDelaysMs[attempt - 1];
      logger.warn(`KRX 종목 목록 요청 재시도 ${attempt}/${attempts - 1}: ${error.message} (${delayMs}ms 후)`);
      await sleepImpl(delayMs);
    }
  }

  const staleCacheDays = options.staleCacheDays ?? DEFAULT_STALE_CACHE_DAYS;
  const fallback = [cached, options.fallbackCache]
    .filter((candidate) => isUsableStaleCache(candidate, staleCacheDays))
    .sort((left, right) => normalizeDate(right.updatedDate).localeCompare(normalizeDate(left.updatedDate)))[0];
  if (fallback) {
    logger.warn(`KRX 종목 목록 요청이 계속 실패해 직전 정상 목록(${fallback.updatedDate})을 사용합니다: ${lastError?.message}`);
    return fallback.stocks;
  }
  throw new Error(`KRX 종목 목록 요청 실패(총 ${attempts}회): ${lastError?.message || "알 수 없는 오류"}`);
}

async function fetchKrxMaster(fetchImpl, timeoutMs) {
  const url = new URL(KRX_LIST_URL);
  url.searchParams.set("_", String(Date.now()));
  const response = await fetchImpl(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/vnd.ms-excel,*/*;q=0.8",
      "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      referer: "https://kind.krx.co.kr/",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const utf8 = parseKrxList(new TextDecoder("utf-8").decode(buffer));
  const eucKr = parseKrxList(new TextDecoder("euc-kr").decode(buffer));
  const stocks = (hangulCount(utf8) >= hangulCount(eucKr) ? utf8 : eucKr)
    // KRX's downloadable list labels KOSPI as "유가" rather than "유가증권".
    .filter((stock) => /유가|코스닥/.test(stock.market))
    .filter((stock) => /^\d{6}$/.test(stock.code));
  if (!isValidMaster(stocks)) throw new Error(`응답 해석 실패: ${stocks.length}종목`);
  return stocks;
}

// KRX's corporation download omits preferred shares (for example 005935),
// although they are valid listed equities and are included in KIS's master.
export function addKisPreferredShares(stocks, kisEntries = {}) {
  const merged = new Map(stocks.map((stock) => [stock.code, stock]));
  for (const [code, entry] of Object.entries(kisEntries)) {
    if (merged.has(code) || !isPreferredShareName(entry?.name)) continue;
    merged.set(code, {
      code,
      name: entry.name,
      market: entry.market || "유가",
      sector: "미분류",
    });
  }
  return [...merged.values()];
}

export function parseKrxList(html) {
  return [...String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => {
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => clean(cell[1]));
    // KRX's downloadable company list is: company name, ticker, industry, ... market.
    const codeIndex = cells.findIndex((cell) => /^\d{6}$/.test(cell));
    if (codeIndex < 0) return null;
    const name = cells[0];
    const market = cells.find((cell) => /유가|코스닥|코넥스/.test(cell)) || "";
    const sector = cells[codeIndex + 1] || "미분류";
    return name && market ? { code: cells[codeIndex], name, market, sector } : null;
  }).filter(Boolean);
}

function clean(value) {
  return String(value).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function hangulCount(stocks) {
  return stocks.filter((stock) => /[가-힣]/.test(stock.name)).length;
}

function isPreferredShareName(name) {
  return /(?:우|[1-9]우B)$/.test(String(name || ""));
}

function isValidMaster(stocks) {
  return Array.isArray(stocks)
    && stocks.length > 1000
    && stocks.every((stock) => "sector" in stock)
    && stocks.some((stock) => stock.code === "005930");
}

function isUsableStaleCache(cached, maximumAgeDays) {
  if (!isValidMaster(cached?.stocks)) return false;
  const normalizedDate = normalizeDate(cached.updatedDate);
  const updated = Date.parse(`${normalizedDate}T00:00:00+09:00`);
  const today = Date.parse(`${koreaDate()}T00:00:00+09:00`);
  if (!Number.isFinite(updated) || !Number.isFinite(today)) return false;
  const ageDays = Math.floor((today - updated) / 86_400_000);
  return ageDays >= 0 && ageDays <= maximumAgeDays;
}

function normalizeDate(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : "";
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function koreaDate() {
  const values = dateParts(new Date());
  return `${values.year}-${String(values.month).padStart(2, "0")}-${String(values.day).padStart(2, "0")}`;
}

function dateParts(date) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}
