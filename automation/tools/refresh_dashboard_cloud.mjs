import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadDotEnv, getConfig } from "../src/config.mjs";
import { KisClient } from "../src/kisClient.mjs";
import { addKisPreferredShares, loadKrxMaster } from "../src/krxMaster.mjs";
import { ensureKisListedShares } from "../src/kisMaster.mjs";
import {
  formatFullReport,
  isKoreaMarketOpen,
  resolveLatestCompletedFlowDate,
  scanWholeMarket,
} from "../src/flowService.mjs";
import { refreshMarketRankings } from "../src/marketRankings.mjs";
import { refreshTechnicalIndicators } from "../src/technicalIndicators.mjs";
import { syncHostedDashboard } from "../src/hostedDashboard.mjs";
import { exportScanToExcel } from "../src/excelExporter.mjs";
import { TelegramClient } from "../src/telegram.mjs";
import {
  formatDashboardCompleteMessage,
  formatDashboardStartMessage,
  nonEmptyMessages,
} from "../src/messages.mjs";
import {
  etfCategory,
  mergeDomesticSnapshot,
  mergeEtfSnapshots,
  mergeIntradaySnapshot,
  parseAssignedJson,
  serializeAssignedJson,
} from "../src/cloudState.mjs";

loadDotEnv();
loadDotEnv(".env.hosted");

const config = getConfig();
assertSecrets(config);
const client = new KisClient(config);
const today = koreaDateCompact();
const force = process.env.FORCE_REFRESH === "1";
const runMode = process.env.RUN_MODE === "intraday" ? "intraday" : "close";
const existing = loadDashboard(config.dashboardDataFile);

if (runMode === "close" && !force && existing.dates?.includes(today)) {
  console.log(JSON.stringify({ stage: "skip", reason: "already-updated", date: today }));
  process.exit(0);
}

const openDate = await client.isMarketOpenDate(today);
if (!openDate) {
  console.log(JSON.stringify({ stage: "skip", reason: "market-closed", date: today }));
  process.exit(0);
}

const closingSnapshotGrace = process.env.CLOSING_SNAPSHOT === "1"
  && isKoreaClosingSnapshotGrace(new Date());
if (runMode === "intraday" && !isKoreaMarketOpen(new Date()) && !closingSnapshotGrace) {
  console.log(JSON.stringify({ stage: "skip", reason: "outside-market-hours", date: today }));
  process.exit(0);
}

const date = runMode === "intraday"
  ? today
  : await resolveLatestCompletedFlowDate(client, today, new Date(), { requireRequestedDate: true });
const krxStocks = await loadKrxMaster(config.masterCacheFile);
const kisShares = await ensureKisListedShares(config, date);
const stocks = addKisPreferredShares(krxStocks, kisShares.entries);
if (runMode === "close") await sendTelegramStart(date, stocks.length);

const scan = await scanWholeMarket({
  client,
  stocks,
  date,
  config,
  persist: false,
  includeHistory: false,
  mode: runMode === "intraday" ? "intraday-estimate" : "close",
  onProgress({ completed, total, failed, retryPending = 0, retryRound = 0 }) {
    console.log(JSON.stringify({ stage: "scan", completed, total, failed, retryPending, retryRound }));
  },
});

if (scan.records.length < Math.max(2_000, Math.floor(stocks.length * 0.82))) {
  throw new Error(`완료 종목이 품질 기준보다 적어 기존 데이터를 유지합니다: ${scan.records.length}/${stocks.length}`);
}

const merged = runMode === "intraday"
  ? mergeIntradaySnapshot(existing, scan)
  : mergeDomesticSnapshot(existing, scan);
const etfSnapshots = runMode === "close"
  ? await loadEtfSnapshots(date, kisShares.entries).catch((error) => {
    console.warn(`ETF snapshot skipped: ${error.message}`);
    return [];
  })
  : [];
if (runMode === "close") merged.etfRows = mergeEtfSnapshots(existing.etfRows, etfSnapshots);
writeDashboard(config.dashboardDataFile, merged);

const rankings = runMode === "close"
  ? await refreshMarketRankings(client, config)
  : { skipped: true, reason: "intraday-refresh" };
const indicators = runMode === "close"
  ? await refreshTechnicalIndicators(config)
  : { skipped: true, reason: "intraday-refresh" };
const excelPath = await exportScanToExcel(scan, config);
const latestExcelPath = resolve("./dashboard/latest-flow.xlsx");
copyFileSync(excelPath, latestExcelPath);

let hosted = null;
try {
  hosted = await syncHostedDashboard(config);
} catch (error) {
  console.warn(`Hosted dashboard sync failed: ${error.message}`);
}

const publicUrl = config.publicDashboardUrl
  || hosted?.url
  || "https://heechany.github.io/stock-market-dashboards/dashboard/";
if (runMode === "close") {
  await sendTelegram(scan, excelPath, publicUrl, {
    dates: merged.dates?.length || 0,
    rows: merged.rows?.length || 0,
  });
}

const result = {
  stage: "complete",
  runMode,
  date,
  records: scan.records.length,
  failed: scan.failed,
  durationMs: scan.durationMs,
  etfRows: etfSnapshots.length,
  rankings,
  indicators,
  hosted,
  excelPath,
  latestExcelPath,
  publicUrl,
};
writeJson("./automation/output/dashboard-result.json", result);
console.log(JSON.stringify(result));

async function loadEtfSnapshots(dateValue, entries) {
  const key = String(process.env.KRX_OPEN_API_KEY || "").trim();
  if (key) {
    const response = await fetch(`https://data-dbg.krx.co.kr/svc/apis/etp/etf_bydd_trd?basDd=${dateValue}`, {
      headers: { AUTH_KEY: key, "user-agent": "stock-market-dashboards/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) {
      const payload = await response.json();
      const records = payload.OutBlock_1 || payload.output || [];
      const rows = records.map((row) => {
        const code = String(row.ISU_SRT_CD || row.ISU_CD || "").trim();
        const name = String(row.ISU_NM || code).trim();
        const listedShares = integer(row.LIST_SHRS);
        const referencePrice = integer(row.TDD_CLSPRC) || integer(row.NAV);
        const marketCapWon = integer(row.MKTCAP) || listedShares * referencePrice;
        return { date: dateValue, code, name, category: etfCategory(name), listedShares, referencePrice, marketCapWon };
      }).filter((row) => /^\d{6}$/.test(row.code) && row.listedShares > 0 && row.referencePrice > 0);
      if (rows.length >= 100) return rows;
    }
  }
  const fallback = Object.entries(entries || {}).map(([code, entry]) => ({
    date: dateValue,
    code,
    name: String(entry.name || code),
    category: etfCategory(entry.name),
    listedShares: integer(entry.shares),
    referencePrice: integer(entry.referencePrice),
    marketCapWon: integer(entry.marketCapWon),
    productType: entry.productType,
  })).filter((row) => row.productType === "EF" && row.listedShares > 0 && row.referencePrice > 0);
  if (fallback.length < 100) throw new Error(`ETF 종목 수가 비정상적입니다: ${fallback.length}`);
  return fallback;
}

async function sendTelegramStart(dateValue, total) {
  if (!config.telegramBotToken || !config.allowedChatIds.size) return;
  const telegram = new TelegramClient(config.telegramBotToken);
  const message = formatDashboardStartMessage(dateValue, total);
  for (const chatId of config.allowedChatIds) {
    await safeTelegram(`start message to ${chatId}`, () => telegram.sendMessage(chatId, message));
  }
}

async function sendTelegram(scanValue, filePath, url, history) {
  if (!config.telegramBotToken || !config.allowedChatIds.size) return;
  const telegram = new TelegramClient(config.telegramBotToken);
  for (const chatId of config.allowedChatIds) {
    for (const message of nonEmptyMessages(formatFullReport(scanValue, config.topN))) {
      await safeTelegram(`summary message to ${chatId}`, () => telegram.sendMessage(chatId, message));
    }
    let excelSent = false;
    if (existsSync(filePath)) {
      excelSent = await safeTelegram(
        `Excel document to ${chatId}`,
        () => telegram.sendDocument(chatId, filePath, `수급정리-${scanValue.date}.xlsx`),
      );
    }
    const complete = formatDashboardCompleteMessage({
      date: scanValue.date,
      dates: history.dates,
      rows: history.rows,
      excelSent,
      url,
    });
    await safeTelegram(`completion message to ${chatId}`, () => telegram.sendMessage(chatId, complete));
  }
}

async function safeTelegram(label, action) {
  try {
    await action();
    return true;
  } catch (error) {
    console.warn(`Telegram ${label} skipped: ${error.message}`);
    return false;
  }
}

function loadDashboard(path) {
  return parseAssignedJson(readFileSync(resolve(path), "utf8"), "window.FLOW_DASHBOARD_DATA");
}

function writeDashboard(path, payload) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, serializeAssignedJson("window.FLOW_DASHBOARD_DATA", payload), "utf8");
}

function writeJson(path, payload) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function koreaDateCompact(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}${parts.month}${parts.day}`;
}

function isKoreaClosingSnapshotGrace(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  if (["Sat", "Sun"].includes(parts.weekday)) return false;
  const hhmm = (Number(parts.hour) * 100) + Number(parts.minute);
  return hhmm >= 1530 && hhmm <= 1600;
}

function integer(value) {
  const number = Number(String(value || "0").replaceAll(",", ""));
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function assertSecrets(value) {
  if (!value.kisAppKey || !value.kisAppSecret) {
    throw new Error("KIS_APP_KEY와 KIS_APP_SECRET이 필요합니다.");
  }
}
