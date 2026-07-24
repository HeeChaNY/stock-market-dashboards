import { readJson, writeJson } from "./store.mjs";

const KRX_LIST_URL = "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13";

export async function loadKrxMaster(cacheFile) {
  const cached = readJson(cacheFile);
  if (cached?.updatedDate === koreaDate() && Array.isArray(cached.stocks) && cached.stocks.length > 1000 && cached.stocks.every((stock) => "sector" in stock) && cached.stocks.some((stock) => stock.code === "005930")) {
    return cached.stocks;
  }
  const response = await fetch(KRX_LIST_URL, {
    headers: { "user-agent": "Mozilla/5.0 Korean-stock-supply-bot", accept: "text/html,application/vnd.ms-excel,*/*" },
  });
  if (!response.ok) throw new Error(`KRX 종목 목록 요청 실패: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const utf8 = parseKrxList(new TextDecoder("utf-8").decode(buffer));
  const eucKr = parseKrxList(new TextDecoder("euc-kr").decode(buffer));
  const stocks = (hangulCount(utf8) >= hangulCount(eucKr) ? utf8 : eucKr)
    // KRX's downloadable list labels KOSPI as "유가" rather than "유가증권".
    .filter((stock) => /유가|코스닥/.test(stock.market))
    .filter((stock) => /^\d{6}$/.test(stock.code));
  if (stocks.length < 1000) throw new Error("KRX 종목 목록을 해석하지 못했습니다.");
  writeJson(cacheFile, { updatedDate: koreaDate(), stocks });
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

function koreaDate() {
  const values = dateParts(new Date());
  return `${values.year}-${String(values.month).padStart(2, "0")}-${String(values.day).padStart(2, "0")}`;
}

function dateParts(date) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}
