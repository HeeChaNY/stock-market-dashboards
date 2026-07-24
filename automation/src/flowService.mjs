import { join } from "node:path";
import { fileExists, readJson, writeJson } from "./store.mjs";

const FLOW_FIELDS = {
  foreign: { label: "외국인", qty: "frgn_ntby_qty", value: "frgn_ntby_tr_pbmn" },
  institution: { label: "기관", qty: "orgn_ntby_qty", value: "orgn_ntby_tr_pbmn" },
  pension: { label: "연기금등", qty: "fund_ntby_qty", value: "fund_ntby_tr_pbmn" },
  individual: { label: "개인", qty: "prsn_ntby_qty", value: "prsn_ntby_tr_pbmn" },
};

const INSTITUTION_DETAIL_FIELDS = {
  securities: { label: "증권", qty: "scrt_ntby_qty", value: "scrt_ntby_tr_pbmn" },
  investmentTrust: { label: "투신", qty: "ivtr_ntby_qty", value: "ivtr_ntby_tr_pbmn" },
  privateEquity: { label: "사모펀드", qty: "pe_fund_ntby_vol", value: "pe_fund_ntby_tr_pbmn" },
  bank: { label: "은행", qty: "bank_ntby_qty", value: "bank_ntby_tr_pbmn" },
  insurance: { label: "보험", qty: "insu_ntby_qty", value: "insu_ntby_tr_pbmn" },
  merchantBank: { label: "종금", qty: "mrbn_ntby_qty", value: "mrbn_ntby_tr_pbmn" },
  pensionFund: { label: "연기금등", qty: "fund_ntby_qty", value: "fund_ntby_tr_pbmn" },
  otherOrganization: { label: "기타단체", qty: "etc_orgt_ntby_vol", value: "etc_orgt_ntby_tr_pbmn" },
  otherCorporation: { label: "기타법인", qty: "etc_corp_ntby_vol", value: "etc_corp_ntby_tr_pbmn" },
};

const ALL_FLOW_FIELDS = { ...FLOW_FIELDS, ...INSTITUTION_DETAIL_FIELDS };

export async function scanWholeMarket({ client, stocks, date, config, onProgress = () => {}, persist = true, includeHistory = false, mode = "close" }) {
  const startedAt = Date.now();
  const records = [];
  const historyRecords = [];
  const shareCache = readJson(config.shareCountCacheFile, { version: 1, entries: {} });
  shareCache.entries ||= {};
  let nextIndex = 0;
  let completed = 0;
  const failures = [];
  const retryTargets = [];
  const workers = Array.from({ length: config.scanConcurrency }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= stocks.length) return;
      const stock = stocks[index];
      try {
        const cachedShares = shareCache.entries[stock.code];
        const stockWithTradingName = cachedShares?.name ? { ...stock, name: cachedShares.name } : stock;
        const record = await collectFlowByMode(client, stockWithTradingName, date, mode, {
          listedShares: cachedShares?.shares,
          refreshShareCount: shouldRefreshShareCount(cachedShares, stock.code, date),
          requestAttempts: 1,
          includeHistory,
        });
        if (record) {
          historyRecords.push(...(record._historyRecords || []));
          delete record._historyRecords;
          records.push(record);
          if (record.shareCountRefreshed && record.listedShares > 0) {
            shareCache.entries[stock.code] = { ...cachedShares, shares: record.listedShares, name: cachedShares?.name || stock.name, checkedDate: record.sourceDate };
          }
        }
      } catch (error) {
        const failure = {
          code: stock.code,
          name: stock.name,
          market: stock.market,
          errorCode: error.code || null,
          errorMessage: error.message,
        };
        failure.retryable = isRetryableError(error);
        failures.push(failure);
        if (failure.retryable) retryTargets.push({ stock, failure });
        if (failures.length <= 3) console.warn(`[${stock.code}] ${error.message}`);
      } finally {
        completed += 1;
        if (completed % 500 === 0 || completed === stocks.length) {
          writeJson(config.shareCountCacheFile, shareCache);
          onProgress({ completed, total: stocks.length, failed: failures.length, retryPending: retryTargets.length });
        }
      }
    }
  });
  await Promise.all(workers);

  // Avoid tying up every worker with long exponential sleeps. Run rejected
  // requests through short bulk retry rounds, then recover only the final few
  // at a deliberately slow cadence.
  let pending = retryTargets;
  const retryRounds = config.scanRetryRounds || 6;
  const retryRoundDelayMs = config.scanRetryRoundDelayMs || 500;
  for (let round = 1; round <= retryRounds && pending.length; round += 1) {
    await delay(retryRoundDelayMs);
    const retryBatch = pending;
    const nextPending = [];
    let retryIndex = 0;
    let retryCompleted = 0;
    let lastRetryProgressAt = Date.now();
    const retryWorkers = Array.from({ length: Math.min(config.scanConcurrency, retryBatch.length) }, async () => {
      while (true) {
        const index = retryIndex++;
        if (index >= retryBatch.length) return;
        const target = retryBatch[index];
        const recovered = await retryFailedStock(target, 1);
        if (!recovered) nextPending.push(target);
        retryCompleted += 1;
        const now = Date.now();
        if (retryCompleted === retryBatch.length || retryCompleted % 50 === 0 || now - lastRetryProgressAt >= 15_000) {
          lastRetryProgressAt = now;
          onProgress({
            completed,
            total: stocks.length,
            failed: failures.length,
            retryPending: Math.max(0, retryBatch.length - retryCompleted + nextPending.length),
            retryRound: round,
          });
        }
      }
    });
    await Promise.all(retryWorkers);
    pending = nextPending;
    onProgress({ completed, total: stocks.length, failed: failures.length, retryPending: pending.length, retryRound: round });
    if (pending.length === retryBatch.length && round >= 2) break;
  }

  // Do not run a long sequential fallback here. A thousand rejected symbols with
  // per-symbol exponential sleeps can keep a command alive for hours while
  // appearing frozen. The bounded bulk rounds above recover transient failures;
  // remaining symbols are reported as failures and can be retried by a later run.

  async function retryFailedStock({ stock, failure }, requestAttempts) {
    try {
      const cachedShares = shareCache.entries[stock.code];
      const stockWithTradingName = cachedShares?.name ? { ...stock, name: cachedShares.name } : stock;
      const record = await collectFlowByMode(client, stockWithTradingName, date, mode, {
        listedShares: cachedShares?.shares,
        refreshShareCount: shouldRefreshShareCount(cachedShares, stock.code, date),
        requestAttempts,
        includeHistory,
      });
      if (record) {
        historyRecords.push(...(record._historyRecords || []));
        delete record._historyRecords;
        records.push(record);
        if (record.shareCountRefreshed && record.listedShares > 0) {
          shareCache.entries[stock.code] = { ...cachedShares, shares: record.listedShares, name: cachedShares?.name || stock.name, checkedDate: record.sourceDate };
        }
      }
      const failureIndex = failures.indexOf(failure);
      if (failureIndex >= 0) failures.splice(failureIndex, 1);
      return true;
    } catch (error) {
      failure.errorCode = error.code || null;
      failure.errorMessage = error.message;
      return false;
    }
  }
  writeJson(config.shareCountCacheFile, shareCache);
  const sourceDateCounts = new Map();
  for (const record of records) sourceDateCounts.set(record.sourceDate, (sourceDateCounts.get(record.sourceDate) || 0) + 1);
  const dataDate = [...sourceDateCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || date;
  if (records.length === 0) {
    const reason = failures[0]?.errorMessage || "조회 결과가 비어 있습니다.";
    throw new Error(`수급 데이터가 0건이라 작업을 중단했습니다: ${reason}`);
  }
  const result = {
    date: dataDate,
    requestedDate: date,
    createdAt: new Date().toISOString(),
    total: stocks.length,
    completed,
    failed: failures.length,
    failures,
    durationMs: Date.now() - startedAt,
    dataMode: mode,
    records,
  };
  if (persist) writeJson(scanFile(config, dataDate), result);
  Object.defineProperty(result, "historyRecords", { value: historyRecords, enumerable: false });
  return result;
}

export async function collectStockFlow(client, stock, date, options = {}) {
  const requestAttempts = options.requestAttempts || 6;
  const daily = await requestWithRetry(() => client.investorDaily(stock.code, date), requestAttempts);
  const row = selectDailyRow(daily.output2, date);
  if (!row) throw new Error(`${date} 마감 수급 데이터가 없습니다.`);
  const closePrice = numeric(row.stck_clpr);
  const previousClose = numeric(row.stck_prdy_clpr || row.prdy_clpr);
  const priceChange = signedPriceChange(row.prdy_vrss, row.prdy_vrss_sign, closePrice, previousClose);
  const priceChangePct = optionalNumber(row.prdy_ctrt) ?? (previousClose > 0 ? (priceChange / previousClose) * 100 : null);
  // The KIS daily investor endpoint does not include listed shares. One extra price request
  // lets the bot calculate a real market-cap denominator rather than an arbitrary ratio.
  let listedShares = numeric(options.listedShares);
  let quote = {};
  let shareCountRefreshed = false;
  if (options.refreshShareCount !== false || listedShares <= 0) {
    try {
      const price = await requestWithRetry(() => client.currentPrice(stock.code), requestAttempts);
      quote = price.output || {};
      const freshListedShares = numeric(quote.lstn_stcn);
      if (freshListedShares > 0) {
        listedShares = freshListedShares;
        shareCountRefreshed = true;
      }
    } catch (error) {
      if (listedShares <= 0) throw error;
    }
  }
  const marketCapWon = listedShares > 0 && closePrice > 0 ? listedShares * closePrice : marketCapFromHts(quote.hts_avls);
  const flows = Object.fromEntries(Object.entries(ALL_FLOW_FIELDS).map(([key, definition]) => {
    const quantity = numeric(row[definition.qty]);
    const reportedValueMillionWon = optionalNumber(row[definition.value]);
    const absoluteWon = reportedValueMillionWon == null ? (quantity * closePrice) : (reportedValueMillionWon * 1_000_000);
    return [key, {
      quantity,
      absoluteWon,
      marketCapPct: marketCapWon > 0 ? (absoluteWon / marketCapWon) * 100 : null,
    }];
  }));
  const record = { code: stock.code, name: stock.name, market: stock.market, sector: stock.sector || "미분류", sourceDate: String(row.stck_bsop_date || date), closePrice, priceChange, priceChangePct, tradingVolume: numeric(row.acml_vol), marketCapWon, listedShares, shareCountRefreshed, flows };
  if (options.includeHistory) {
    record._historyRecords = (daily.output2 || []).map((historyRow) => historyRecord(stock, historyRow, listedShares)).filter(Boolean);
  }
  return record;
}

export async function collectIntradayStockFlow(client, stock, date, options = {}) {
  const requestAttempts = options.requestAttempts || 6;
  const [estimatePayload, quotePayload] = await Promise.all([
    requestWithRetry(() => client.investorTrendEstimate(stock.code), requestAttempts),
    requestWithRetry(() => client.currentPrice(stock.code), requestAttempts),
  ]);
  const estimateRows = [estimatePayload.output2, estimatePayload.output]
    .find((rows) => Array.isArray(rows)) || [];
  const estimate = [...estimateRows].sort((a, b) => numeric(b.bsop_hour_gb) - numeric(a.bsop_hour_gb))[0] || null;
  const quote = quotePayload.output || {};
  const closePrice = numeric(quote.stck_prpr);
  if (closePrice <= 0) throw new Error("장중 현재가를 조회하지 못했습니다.");
  const priceChange = signedPriceChange(quote.prdy_vrss, quote.prdy_vrss_sign, closePrice, 0);
  const priceChangePct = optionalNumber(quote.prdy_ctrt);
  const listedShares = numeric(quote.lstn_stcn) || numeric(options.listedShares);
  const marketCapWon = listedShares > 0 ? listedShares * closePrice : marketCapFromHts(quote.hts_avls);
  const unavailable = () => ({ quantity: null, absoluteWon: null, marketCapPct: null });
  const estimatedFlow = (field) => {
    if (!estimate || optionalNumber(estimate[field]) == null) return unavailable();
    const quantity = numeric(estimate[field]);
    const absoluteWon = quantity * closePrice;
    return {
      quantity,
      absoluteWon,
      marketCapPct: marketCapWon > 0 ? (absoluteWon / marketCapWon) * 100 : null,
      estimated: true,
    };
  };
  const flows = Object.fromEntries(Object.keys(ALL_FLOW_FIELDS).map((key) => [key, unavailable()]));
  flows.foreign = estimatedFlow("frgn_fake_ntby_qty");
  flows.institution = estimatedFlow("orgn_fake_ntby_qty");
  return {
    code: stock.code,
    name: stock.name,
    market: stock.market,
    sector: stock.sector || "미분류",
    sourceDate: date,
    closePrice,
    priceChange,
    priceChangePct,
    tradingVolume: numeric(quote.acml_vol),
    marketCapWon,
    listedShares,
    shareCountRefreshed: numeric(quote.lstn_stcn) > 0,
    dataMode: "intraday-estimate",
    estimateAvailable: Boolean(estimate),
    estimateTimeCode: estimate?.bsop_hour_gb || null,
    flows,
  };
}

function collectFlowByMode(client, stock, date, mode, options) {
  return mode === "intraday-estimate"
    ? collectIntradayStockFlow(client, stock, date, options)
    : collectStockFlow(client, stock, date, options);
}

export function isKoreaMarketOpen(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  if (["Sat", "Sun"].includes(values.weekday)) return false;
  const hhmm = (Number(values.hour) * 100) + Number(values.minute);
  return hhmm >= 900 && hhmm <= 1530;
}

export async function resolveLatestCompletedFlowDate(client, requestedDate, now = new Date(), options = {}) {
  let candidate = requestedDate;
  const koreaNow = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  const koreaToday = koreaNow.toISOString().slice(0, 10).replaceAll("-", "");
  const koreaTime = (koreaNow.getUTCHours() * 100) + koreaNow.getUTCMinutes();
  // The scheduled dashboard starts after the regular session at 16:00 KST.
  // From that point onward, probe today's completed investor row first; the
  // requireRequestedDate guard still prevents stale data from being published.
  if (requestedDate === koreaToday && koreaTime < 1600) candidate = previousCalendarDate(candidate);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const payload = await requestWithRetry(() => client.investorDaily("005930", candidate), 2);
    const available = (payload.output2 || [])
      .map((row) => String(row.stck_bsop_date || ""))
      .filter((date) => /^\d{8}$/.test(date) && date <= candidate)
      .sort()
      .at(-1);
    if (available) {
      if (options.requireRequestedDate && available !== requestedDate) {
        const error = new Error(`${requestedDate} 확정 수급이 아직 제공되지 않았습니다. 현재 최신 확정일은 ${available}입니다. 잠시 후 /dashboard를 다시 실행해 주세요.`);
        error.code = "FLOW_DATE_NOT_READY";
        throw error;
      }
      return available;
    }
    candidate = previousCalendarDate(candidate);
  }
  throw new Error("최근 마감 수급 기준일을 확인하지 못했습니다. 잠시 후 다시 실행해 주세요.");
}

export async function singleStockFlow(client, code, date) {
  const stock = { code, name: code, market: "" };
  return collectStockFlow(client, stock, date);
}

export async function quickRankings(client) {
  const requests = [
    ["외국인 순매수", "1", "0"], ["외국인 순매도", "1", "1"],
    ["기관 순매수", "2", "0"], ["기관 순매도", "2", "1"],
  ];
  const rankings = [];
  // This KIS ranking endpoint has a tighter per-second limit than general quote APIs.
  // Run the four views serially so a user-facing /quick command does not self-throttle.
  for (const [title, investor, sort] of requests) {
    const payload = await client.foreignInstitutionRanking({ investor, sort, amount: true });
    rankings.push({ title, rows: payload.Output || payload.output || [] });
    if (rankings.length < requests.length) await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  return rankings;
}

export async function exactQuickRankings(client, date, topN = 10) {
  const candidates = await quickRankings(client);
  const candidateRows = candidates.flatMap((ranking) => ranking.rows.slice(0, Math.max(15, topN + 5)));
  const codes = [...new Set(candidateRows.map((row) => row.mksc_shrn_iscd).filter((code) => /^\d{6}$/.test(String(code))))];
  const exactRows = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(4, codes.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= codes.length) return;
      const code = codes[index];
      try {
        const payload = await requestWithRetry(() => client.investorDaily(code, date));
        const row = selectDailyRow(payload.output2, date);
        if (!row) continue;
        exactRows.push({
          code,
          name: candidateRows.find((item) => item.mksc_shrn_iscd === code)?.hts_kor_isnm || code,
          sourceDate: String(row.stck_bsop_date || date),
          foreign: exactFlow(row, "frgn_ntby_qty", "frgn_ntby_tr_pbmn"),
          institution: exactFlow(row, "orgn_ntby_qty", "orgn_ntby_tr_pbmn"),
        });
      } catch (error) {
        console.warn(`Quick exact lookup failed [${code}]: ${error.message}`);
      }
    }
  });
  await Promise.all(workers);
  const dateCounts = new Map();
  for (const row of exactRows) dateCounts.set(row.sourceDate, (dateCounts.get(row.sourceDate) || 0) + 1);
  const sourceDate = [...dateCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || date;
  const group = (title, flowKey, direction) => ({
    title,
    rows: [...exactRows]
      .filter((row) => direction > 0 ? row[flowKey].amountWon > 0 : row[flowKey].amountWon < 0)
      .sort((a, b) => direction > 0 ? b[flowKey].amountWon - a[flowKey].amountWon : a[flowKey].amountWon - b[flowKey].amountWon)
      .slice(0, topN)
      .map((row) => ({ ...row, flow: row[flowKey] })),
  });
  return {
    date: sourceDate,
    groups: [
      group("외국인 순매수", "foreign", 1),
      group("외국인 순매도", "foreign", -1),
      group("기관 순매수", "institution", 1),
      group("기관 순매도", "institution", -1),
    ],
  };
}

export function formatExactQuickRankings(result) {
  const messages = [`⚡ 수급 상위 빠른 조회 — ${result.date}\n상위 후보는 한투 금액 랭킹으로 찾고, 표시 값은 종목별 일별 투자자 수급으로 재검증했습니다.`];
  for (const group of result.groups) {
    const lines = [`${group.title}`];
    group.rows.forEach((row, index) => {
      lines.push(`${index + 1}. ${row.name} ${signed(row.flow.amountWon)} (${signedShares(row.flow.quantity)}주)`);
    });
    messages.push(lines.join("\n"));
  }
  return messages;
}

export function loadLatestScan(config) {
  const state = readJson(config.stateFile, {});
  const scan = state.lastScanDate ? readJson(scanFile(config, state.lastScanDate)) : null;
  if (!scan) return null;
  const master = readJson(config.shareCountCacheFile, {});
  return {
    ...scan,
    records: scan.records.map((record) => ({
      ...record,
      name: master.entries?.[record.code]?.name || record.name,
    })),
  };
}

export function markScanComplete(config, date) {
  writeJson(config.stateFile, { lastScanDate: date, completedAt: new Date().toISOString() });
}

export function formatFullReport(scan, topN) {
  const valid = scan.records.filter((record) => record.marketCapWon > 0);
  const intraday = scan.dataMode === "intraday-estimate";
  const heading = [
    `📊 ${intraday ? "장중 추정" : "전종목 마감"} 수급 — ${scan.date}`,
    `집계 ${scan.records.length.toLocaleString()} / 대상 ${scan.total.toLocaleString()}종목${scan.failed ? ` · 실패 ${scan.failed}` : ""}`,
    intraday
      ? "외국인·기관 가집계 수량 × 현재가로 계산한 추정 금액입니다. 연기금·기관 세부는 장 마감 후 확정됩니다."
      : "금액은 순매수(+, 매도는 −), 시총비는 순매수금액 ÷ 시가총액입니다.",
  ].join("\n");
  const groups = intraday
    ? [["foreign", "외국인"], ["institution", "기관"]]
    : [["foreign", "외국인"], ["institution", "기관"], ["pension", "연기금등"]];
  const messages = [heading];
  for (const [key, label] of groups) {
    messages.push(formatRankSection(valid, key, label, "absoluteWon", "절대금액", topN));
    messages.push(formatRankSection(valid, key, label, "marketCapPct", "시총 대비", topN));
  }
  return messages;
}

export function formatOfficialQuickReport(scan, topN) {
  const valid = scan.records.filter((record) => record.marketCapWon > 0);
  return [
    `⚡ 확정 수급 빠른 요약 — ${scan.date}\n기준: 한투 종목별 일별 투자자 매매동향 · 전종목 스캔 완료본`,
    formatRankSection(valid, "foreign", "외국인", "absoluteWon", "절대 순매수 금액", topN),
    formatRankSection(valid, "institution", "기관", "absoluteWon", "절대 순매수 금액", topN),
    formatRankSection(valid, "pension", "연기금등", "absoluteWon", "절대 순매수 금액", topN),
  ];
}

export function formatQuickReport(rankings, topN) {
  const lines = [
    "⚡ 장중/마감 잠정 수급 상위",
    "한투 API의 금액 기준 정렬 결과입니다. API 응답에 거래대금이 없을 때는 순매수 수량을 주(株) 단위로 표기합니다.",
    "정확한 순매수 거래대금은 마감 후 /report 또는 /excel의 확정 수급을 확인하세요.",
  ];
  for (const ranking of rankings) {
    lines.push(`\n${ranking.title}`);
    ranking.rows.slice(0, topN).forEach((row, index) => {
      const name = row.hts_kor_isnm || row.mksc_shrn_iscd || "종목";
      const amount = optionalNumber(row.ntby_tr_pbmn);
      const quantity = numeric(row.ntby_qty);
      const isSellRanking = ranking.title.includes("순매도");
      const display = amount == null
        ? `${signedShares(forceDirection(quantity, isSellRanking))}주`
        : signed(forceDirection(amount, isSellRanking));
      lines.push(`${index + 1}. ${name} ${display}`);
    });
  }
  return splitForTelegram(lines.join("\n"));
}

export function formatSingleStock(record) {
  const changeText = record.priceChangePct == null ? "전일 대비 —" : `전일 대비 ${signedWon(record.priceChange)} (${record.priceChangePct >= 0 ? "+" : ""}${record.priceChangePct.toFixed(2)}%)`;
  const lines = [`📌 ${record.name} (${record.code})`, `종가 ${formatWon(record.closePrice)} · ${changeText} · 시총 ${formatWon(record.marketCapWon)}`, ""];
  for (const [key, definition] of Object.entries(FLOW_FIELDS)) {
    const flow = record.flows[key];
    lines.push(`${definition.label}: ${signed(flow.absoluteWon)} (${signedShares(flow.quantity)}주) · 시총 ${flow.marketCapPct == null ? "—" : `${flow.marketCapPct >= 0 ? "+" : ""}${flow.marketCapPct.toFixed(3)}%`}`);
  }
  const details = Object.entries(INSTITUTION_DETAIL_FIELDS)
    .filter(([key]) => record.flows[key])
    .map(([key, definition]) => {
      const flow = record.flows[key];
      return `${definition.label}: ${signed(flow.absoluteWon)} (${signedShares(flow.quantity)}주)`;
    });
  if (details.length) lines.push("", "기관 세부 수급", ...details);
  return lines.join("\n");
}

function formatRankSection(records, flowKey, label, metric, title, topN) {
  const sortBy = (direction) => [...records]
    .filter((record) => Number.isFinite(record.flows[flowKey][metric]))
    .sort((a, b) => direction * (b.flows[flowKey][metric] - a.flows[flowKey][metric]))
    .slice(0, topN);
  const render = (record, index) => {
    const flow = record.flows[flowKey];
    const primary = metric === "absoluteWon" ? signed(flow.absoluteWon) : `${flow.marketCapPct >= 0 ? "+" : ""}${flow.marketCapPct.toFixed(3)}%`;
    return `${index + 1}. ${record.name} ${primary} · ${formatWon(flow.absoluteWon)}`;
  };
  const buy = sortBy(1).map(render);
  const sell = sortBy(-1).map(render);
  return [`📈 ${label} ${title} 순매수`, ...buy, "", `📉 ${label} ${title} 순매도`, ...sell].join("\n");
}

function selectDailyRow(rows, date) {
  if (!Array.isArray(rows)) return null;
  return rows.find((row) => String(row.stck_bsop_date) === date) || rows[0] || null;
}

function previousCalendarDate(date) {
  const value = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)) - 1));
  return value.toISOString().slice(0, 10).replaceAll("-", "");
}

function scanFile(config, date) {
  return join(config.scanDirectory, `full-scan-${date}.json`);
}

async function requestWithRetry(request, attempts = 6) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (!/EGW00201|429|초당|접근토큰.*1분/i.test(error.code || error.message) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1250 * (attempt + 1)));
    }
  }
  throw lastError;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableError(error) {
  const message = `${error?.code || ""} ${error?.message || ""}`;
  return /EGW00201|429|too many|rate.?limit|timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|초당|호출.?제한|거래건수/i.test(message);
}

function numeric(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value) {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function historyRecord(stock, row, listedShares) {
  const date = String(row?.stck_bsop_date || "");
  const closePrice = numeric(row?.stck_clpr);
  if (!/^\d{8}$/.test(date) || closePrice <= 0) return null;
  const marketCapWon = listedShares > 0 ? listedShares * closePrice : 0;
  const flow = (qtyField, valueField) => {
    const quantity = numeric(row[qtyField]);
    const reportedValueMillionWon = optionalNumber(row[valueField]);
    return {
      quantity,
      absoluteWon: reportedValueMillionWon == null ? quantity * closePrice : reportedValueMillionWon * 1_000_000,
    };
  };
  return {
    date,
    code: stock.code,
    name: stock.name,
    market: stock.market,
    sector: stock.sector || "미분류",
    closePrice,
    priceChangePct: optionalNumber(row.prdy_ctrt),
    tradingVolume: numeric(row.acml_vol),
    marketCapWon,
    foreign: flow("frgn_ntby_qty", "frgn_ntby_tr_pbmn"),
    institution: flow("orgn_ntby_qty", "orgn_ntby_tr_pbmn"),
    pension: flow("fund_ntby_qty", "fund_ntby_tr_pbmn"),
  };
}

function exactFlow(row, quantityField, amountField) {
  const amountMillionWon = optionalNumber(row[amountField]);
  return {
    quantity: numeric(row[quantityField]),
    amountWon: amountMillionWon == null ? 0 : amountMillionWon * 1_000_000,
  };
}

function shouldRefreshShareCount(entry, code, date) {
  if (!entry?.shares) return true;
  if (entry.checkedDate === date) return false;
  const dayBucket = Math.floor(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))) / 86_400_000) % 7;
  return Number(code) % 7 === dayBucket;
}

function forceDirection(value, negative) {
  const amount = Number(value) || 0;
  return negative ? -Math.abs(amount) : Math.abs(amount);
}

function marketCapFromHts(value) {
  // hts_avls is supplied by KIS in KRW 100-million units. Listed shares is preferred above.
  return numeric(value) * 100_000_000;
}

function signed(value) {
  const prefix = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${prefix}${formatWon(Math.abs(value))}`;
}

function signedWon(value) {
  const amount = Number(value) || 0;
  return `${amount > 0 ? "+" : amount < 0 ? "−" : ""}${Math.abs(Math.round(amount)).toLocaleString()}원`;
}

function signedPriceChange(rawChange, signCode, closePrice, previousClose) {
  const change = numeric(rawChange);
  if (change) return ["4", "5"].includes(String(signCode)) ? -Math.abs(change) : change;
  return previousClose > 0 ? closePrice - previousClose : 0;
}

function signedShares(value) {
  const amount = Number(value) || 0;
  const prefix = amount > 0 ? "+" : amount < 0 ? "−" : "";
  return `${prefix}${Math.abs(Math.round(amount)).toLocaleString()}`;
}

function formatWon(value) {
  const absolute = Math.abs(Number(value) || 0);
  if (absolute >= 1_000_000_000_000) return `${(absolute / 1_000_000_000_000).toFixed(2)}조`;
  if (absolute >= 100_000_000) return `${(absolute / 100_000_000).toFixed(1)}억`;
  if (absolute >= 10_000) return `${(absolute / 10_000).toFixed(0)}만`;
  return `${Math.round(absolute).toLocaleString()}원`;
}

function splitForTelegram(text, maxLength = 3500) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (`${current}\n${line}`.length > maxLength) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
