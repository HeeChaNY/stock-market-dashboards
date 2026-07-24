import { TelegramClient } from "../src/telegram.mjs";

const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const chatIds = String(process.env.ALLOWED_CHAT_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
const job = process.argv[2] || "자동 갱신";
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : "";

if (token && chatIds.length) {
  const telegram = new TelegramClient(token);
  for (const chatId of chatIds) {
    await telegram.sendMessage(chatId, `⚠️ ${job} 실패\n${runUrl || "GitHub Actions 실행 로그를 확인하세요."}`);
  }
}
