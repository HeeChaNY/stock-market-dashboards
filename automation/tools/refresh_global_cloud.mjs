import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadDotEnv, getConfig } from "../src/config.mjs";
import { formatGlobalTelegram, refreshGlobalMarkets } from "../src/globalMarkets.mjs";
import { syncHostedGlobalMarkets } from "../src/hostedDashboard.mjs";
import { TelegramClient } from "../src/telegram.mjs";
import { parseAssignedJson, serializeAssignedJson } from "../src/cloudState.mjs";
import { nonEmptyMessages } from "../src/messages.mjs";

loadDotEnv();
loadDotEnv(".env.hosted");
const config = getConfig();
const outputPath = resolve(config.globalMarketDataFile);
const embeddedPath = resolve("./global/global-data.js");
const force = process.env.FORCE_REFRESH === "1";

await seedPreviousPayload();
const previous = readJson(outputPath);
const today = koreaDate();
if (!force && previous?.date === today) {
  writeFileSync(embeddedPath, serializeAssignedJson("window.GLOBAL_MARKET_DATA", previous), "utf8");
  console.log(JSON.stringify({ stage: "skip", reason: "already-updated", date: today }));
  process.exit(0);
}

const payload = await refreshGlobalMarkets(config, {
  onProgress({ phase, completed, total, label }) {
    console.log(JSON.stringify({ stage: "global", phase, completed, total, label }));
  },
});
writeFileSync(embeddedPath, serializeAssignedJson("window.GLOBAL_MARKET_DATA", payload), "utf8");

let hosted = null;
try {
  hosted = await syncHostedGlobalMarkets(config, payload);
} catch (error) {
  console.warn(`Hosted global sync failed: ${error.message}`);
}

const publicUrl = config.publicGlobalUrl
  || hosted?.url
  || "https://heechany.github.io/stock-market-dashboards/global/";
try {
  await sendTelegram(payload, publicUrl);
} catch (error) {
  console.warn(`Telegram notification skipped: ${error.message}`);
}

const result = {
  stage: "complete",
  date: payload.date,
  stocks: payload.stocks?.length || 0,
  markets: payload.markets?.length || 0,
  hosted,
  publicUrl,
};
writeJson("./automation/output/global-result.json", result);
console.log(JSON.stringify(result));

async function seedPreviousPayload() {
  if (existsSync(outputPath)) return;
  mkdirSync(dirname(outputPath), { recursive: true });
  try {
    const embedded = parseAssignedJson(readFileSync(embeddedPath, "utf8"), "window.GLOBAL_MARKET_DATA");
    if (embedded?.generatedAt) {
      writeJson(outputPath, embedded);
      return;
    }
  } catch {}
  const baseUrl = String(config.hostedGlobalUrl || "").replace(/\/$/, "");
  if (!baseUrl) return;
  try {
    const response = await fetch(`${baseUrl}/api/global`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return;
    const payload = await response.json();
    if (payload?.generatedAt) writeJson(outputPath, payload);
  } catch {}
}

async function sendTelegram(payload, url) {
  if (!config.telegramBotToken || !config.allowedChatIds.size) return;
  const telegram = new TelegramClient(config.telegramBotToken);
  const messages = nonEmptyMessages(formatGlobalTelegram(payload));
  for (const chatId of config.allowedChatIds) {
    for (const message of messages) {
      await telegram.sendMessage(chatId, message);
    }
    await telegram.sendMessage(chatId, `✅ 글로벌 스크리너 자동 갱신 완료 · ${payload.date}\n${url}`);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, payload) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function koreaDate(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
