import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDashboardCompleteMessage,
  formatDashboardStartMessage,
  nonEmptyMessages,
} from "../src/messages.mjs";
import { formatFullReport } from "../src/flowService.mjs";

test("Telegram messages omit empty formatter output", () => {
  assert.deepEqual(
    nonEmptyMessages([" 첫 번째 ", "", "   ", null, undefined, "두 번째"]),
    ["첫 번째", "두 번째"],
  );
});

test("Telegram messages tolerate non-array formatter output", () => {
  assert.deepEqual(nonEmptyMessages(null), []);
});

test("dashboard automation announces the same scan scope as /dashboard", () => {
  assert.equal(
    formatDashboardStartMessage("20260728", 2687),
    [
      "📥 20260728 자동 /dashboard 전종목 수급 스캔 시작",
      "대상 2,687종목",
      "외국인·기관·연기금등을 절대금액과 시총 대비로 집계합니다.",
    ].join("\n"),
  );
});

test("dashboard completion includes history, Excel status, and public link", () => {
  const message = formatDashboardCompleteMessage({
    date: "20260728",
    dates: 31,
    rows: 80578,
    excelSent: true,
    url: "https://example.test/dashboard/",
  });
  assert.match(message, /31거래일 · 80,578건 저장/);
  assert.match(message, /Excel 파일도 전송했습니다/);
  assert.match(message, /https:\/\/example\.test\/dashboard\//);
});

test("buy and sell rankings are sent as separate Telegram messages", () => {
  const scan = {
    date: "20260730",
    dataMode: "close",
    total: 2,
    failed: 0,
    records: [
      {
        name: "매수주", marketCapWon: 1_000,
        flows: {
          foreign: { absoluteWon: 100, marketCapPct: 10 },
          institution: { absoluteWon: 50, marketCapPct: 5 },
          pension: { absoluteWon: 10, marketCapPct: 1 },
        },
      },
      {
        name: "매도주", marketCapWon: 1_000,
        flows: {
          foreign: { absoluteWon: -100, marketCapPct: -10 },
          institution: { absoluteWon: -50, marketCapPct: -5 },
          pension: { absoluteWon: -10, marketCapPct: -1 },
        },
      },
    ],
  };
  const messages = formatFullReport(scan, 2);
  assert.equal(messages.some((message) => message.includes("순매수") && message.includes("순매도")), false);
  assert.equal(messages.length, 13);
});
