import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadDotEnv(filePath = ".env") {
  const path = resolve(filePath);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['\"]|['\"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

export function getConfig(env = process.env) {
  const number = (key, fallback) => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || "",
    allowedChatIds: new Set((env.ALLOWED_CHAT_IDS || "").split(",").map((x) => x.trim()).filter(Boolean)),
    kisAppKey: env.KIS_APP_KEY || "",
    kisAppSecret: env.KIS_APP_SECRET || "",
    kisBaseUrl: (env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443").replace(/\/$/, ""),
    requestsPerSecond: number("SCAN_REQUESTS_PER_SECOND", 8),
    scanConcurrency: Math.min(number("SCAN_CONCURRENCY", 8), 12),
    scanRetryRounds: Math.min(number("SCAN_RETRY_ROUNDS", 6), 8),
    scanRetryRoundDelayMs: number("SCAN_RETRY_ROUND_DELAY_MS", 500),
    topN: Math.min(number("SCAN_TOP_N", 15), 30),
    quickReportTime: env.QUICK_REPORT_TIME || "16:10",
    dashboardRefreshTime: env.DASHBOARD_REFRESH_TIME || "16:00",
    newsMorningTime: env.NEWS_MORNING_TIME || "08:00",
    newsCloseTime: env.NEWS_CLOSE_TIME || "16:00",
    masterCacheFile: env.MASTER_CACHE_FILE || "./data/krx-master.json",
    shareCountCacheFile: env.SHARE_COUNT_CACHE_FILE || "./data/listed-shares.json",
    scanDirectory: env.SCAN_DIRECTORY || "./data/scans",
    exportDirectory: env.EXPORT_DIRECTORY || "./automation/output",
    flowHistoryDatabase: env.FLOW_HISTORY_DATABASE || "./data/flow-history.sqlite3",
    flowHistoryUpdateFile: env.FLOW_HISTORY_UPDATE_FILE || "./data/flow-history-update.json",
    flowHistoryStateFile: env.FLOW_HISTORY_STATE_FILE || "./data/flow-history-state.json",
    dashboardDataFile: env.DASHBOARD_DATA_FILE || "./dashboard/data.js",
    globalMarketDataFile: env.GLOBAL_MARKET_DATA_FILE || "./data/global-market.json",
    hostedDashboardUrl: env.HOSTED_DASHBOARD_URL || "",
    hostedDashboardSyncToken: env.HOSTED_DASHBOARD_SYNC_TOKEN || "",
    hostedDashboardAuthToken: env.HOSTED_DASHBOARD_AUTH_TOKEN || "",
    publicDashboardUrl: env.PUBLIC_DASHBOARD_URL || env.HOSTED_DASHBOARD_URL || "",
    hostedGlobalUrl: env.HOSTED_GLOBAL_URL || "",
    hostedGlobalSyncToken: env.HOSTED_GLOBAL_SYNC_TOKEN || env.HOSTED_DASHBOARD_SYNC_TOKEN || "",
    hostedGlobalAuthToken: env.HOSTED_GLOBAL_AUTH_TOKEN || "",
    publicGlobalUrl: env.PUBLIC_GLOBAL_URL || env.HOSTED_GLOBAL_URL || "",
    stateFile: "./data/state.json",
    pythonBin: env.PYTHON_BIN || "python",
  };
}
