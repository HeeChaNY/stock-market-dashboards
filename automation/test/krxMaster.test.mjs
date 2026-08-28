import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadKrxMaster } from "../src/krxMaster.mjs";

test("KRX 403은 재시도 후 정상 종목 목록으로 복구한다", async () => {
  const cacheFile = join(mkdtempSync(join(tmpdir(), "krx-master-")), "master.json");
  const calls = [];
  const fetchImpl = async () => {
    calls.push(Date.now());
    if (calls.length < 3) return response(403, "Forbidden");
    return response(200, validMasterHtml());
  };

  const stocks = await loadKrxMaster(cacheFile, {
    fetchImpl,
    retryDelaysMs: [0, 0],
    sleepImpl: async () => {},
    logger: silentLogger,
  });

  assert.equal(calls.length, 3);
  assert.ok(stocks.length > 1000);
  assert.equal(stocks.find((stock) => stock.code === "005930")?.name, "삼성전자");
  assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")).stocks.length, stocks.length);
});

test("KRX가 계속 차단되면 14일 이내 직전 정상 캐시를 사용한다", async () => {
  const cacheFile = join(mkdtempSync(join(tmpdir(), "krx-master-")), "master.json");
  const stocks = validMasterStocks();
  writeFileSync(cacheFile, JSON.stringify({ updatedDate: koreaDateDaysAgo(1), stocks }), "utf8");
  let calls = 0;

  const result = await loadKrxMaster(cacheFile, {
    fetchImpl: async () => { calls += 1; return response(403, "Forbidden"); },
    retryDelaysMs: [0, 0],
    sleepImpl: async () => {},
    logger: silentLogger,
  });

  assert.equal(calls, 3);
  assert.deepEqual(result, stocks);
});

test("유효기간이 지난 캐시는 KRX 실패를 성공으로 숨기지 않는다", async () => {
  const cacheFile = join(mkdtempSync(join(tmpdir(), "krx-master-")), "master.json");
  writeFileSync(cacheFile, JSON.stringify({ updatedDate: koreaDateDaysAgo(30), stocks: validMasterStocks() }), "utf8");

  await assert.rejects(() => loadKrxMaster(cacheFile, {
    fetchImpl: async () => response(403, "Forbidden"),
    retryDelaysMs: [0],
    sleepImpl: async () => {},
    logger: silentLogger,
  }), /총 2회.*HTTP 403/);
});

const silentLogger = { warn() {} };

function response(status, body) {
  return new Response(body, { status });
}

function validMasterHtml() {
  return validMasterStocks().map((stock) => `<tr><td>${stock.name}</td><td>${stock.code}</td><td>${stock.sector}</td><td>${stock.market}</td></tr>`).join("");
}

function validMasterStocks() {
  return Array.from({ length: 1002 }, (_, index) => ({
    code: index === 0 ? "005930" : String(100000 + index).slice(-6),
    name: index === 0 ? "삼성전자" : `테스트${index}`,
    market: index % 2 ? "코스닥" : "유가",
    sector: "테스트업종",
  }));
}

function koreaDateDaysAgo(days) {
  const date = new Date(Date.now() - days * 86_400_000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
