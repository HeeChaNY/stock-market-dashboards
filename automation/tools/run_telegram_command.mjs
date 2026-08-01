import { loadDotEnv, getConfig } from "../src/config.mjs";
import { loadLatestDashboardScan } from "../src/dashboardScan.mjs";
import { exportScanToExcel } from "../src/excelExporter.mjs";
import { formatFullReport, isKoreaMarketOpen, resolveLatestCompletedFlowDate, scanWholeMarket } from "../src/flowService.mjs";
import { KisClient } from "../src/kisClient.mjs";
import { addKisPreferredShares, loadKrxMaster } from "../src/krxMaster.mjs";
import { ensureKisListedShares, filterStocksByMarketCap } from "../src/kisMaster.mjs";
import { nonEmptyMessages } from "../src/messages.mjs";
import { TelegramClient } from "../src/telegram.mjs";

loadDotEnv();
loadDotEnv(".env.hosted");

const command = String(process.env.BOT_COMMAND || "").trim().toLowerCase();
const chatId = String(process.env.REQUEST_CHAT_ID || "").trim();
const config = getConfig();

if (!config.telegramBotToken) throw new Error("TELEGRAM_BOT_TOKEN이 없습니다.");
if (!chatId || !config.allowedChatIds.has(chatId)) throw new Error("허용되지 않은 Chat ID입니다.");
if (!new Set(["excel", "compact"]).has(command)) throw new Error(`지원하지 않는 클라우드 명령입니다: ${command}`);

const telegram = new TelegramClient(config.telegramBotToken);

if (command === "excel") {
  const scan = loadLatestDashboardScan(config.dashboardDataFile);
  const filePath = await exportScanToExcel(scan, config);
  const suffix = scan.dataMode === "intraday-estimate" ? "-장중추정" : "";
  await telegram.sendDocument(chatId, filePath, `수급정리-${scan.date}${suffix}.xlsx`);
  await telegram.sendMessage(chatId, `✅ 최근 저장 데이터 기준 Excel 전송 완료 · ${scan.date}\nAPI 재조회 없이 ${scan.records.length.toLocaleString()}종목을 반영했습니다.`);
  process.exit(0);
}

await telegram.sendMessage(chatId, "시총 2,000억원 이상 종목을 조회 중입니다. 완료되면 수급 요약과 Excel을 보내드립니다.");
const client = new KisClient(config);
const today = koreaDateCompact();
const openDate = await client.isMarketOpenDate(today);
const intraday = openDate && isKoreaMarketOpen(new Date());
const date = intraday ? today : await resolveLatestCompletedFlowDate(client, today, new Date());
const krxStocks = await loadKrxMaster(config.masterCacheFile);
const kisShares = await ensureKisListedShares(config, date);
const allStocks = addKisPreferredShares(krxStocks, kisShares.entries);
const stocks = filterStocksByMarketCap(allStocks, kisShares.entries, 200_000_000_000);
if (stocks.length < 300) throw new Error(`시총 필터 결과가 비정상적입니다: ${stocks.length}종목`);

const scan = await scanWholeMarket({
  client,
  stocks,
  date,
  config,
  persist: false,
  includeHistory: false,
  mode: intraday ? "intraday-estimate" : "close",
  onProgress({ completed, total, failed, retryPending = 0, retryRound = 0 }) {
    console.log(JSON.stringify({ stage: "compact", completed, total, failed, retryPending, retryRound }));
  },
});
scan.scope = { type: "compact", minimumMarketCapWon: 200_000_000_000 };
for (const message of nonEmptyMessages(formatFullReport(scan, config.topN))) await telegram.sendMessage(chatId, message);
const filePath = await exportScanToExcel(scan, config, { compact: true });
const suffix = intraday ? "-장중추정" : "";
await telegram.sendDocument(chatId, filePath, `수급정리-compact-${scan.date}${suffix}.xlsx`);
await telegram.sendMessage(chatId, `✅ /compact 완료 · ${scan.date}\n시총 2,000억원 이상 ${scan.records.length.toLocaleString()}종목을 반영했습니다.`);

function koreaDateCompact(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}${parts.month}${parts.day}`;
}
