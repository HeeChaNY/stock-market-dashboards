import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeDomesticSnapshot,
  mergeEtfSnapshots,
  mergeIntradaySnapshot,
  mergeShortBalanceSnapshots,
  parseAssignedJson,
  serializeAssignedJson,
} from "../src/cloudState.mjs";

test("assigned JSON round-trips", () => {
  const source = serializeAssignedJson("window.TEST_DATA", { ok: true, rows: [1, 2] });
  assert.deepEqual(parseAssignedJson(source, "window.TEST_DATA"), { ok: true, rows: [1, 2] });
});

test("domestic snapshot replaces one date and preserves history", () => {
  const existing = {
    dates: ["20260723", "20260724"],
    columns: [],
    rows: [
      ["20260724", "005930", "old", "유가", "전자", 1, 1],
      ["20260723", "005930", "older", "유가", "전자", 1, 1],
    ],
  };
  const records = Array.from({ length: 1_050 }, (_, index) => ({
    code: String(index).padStart(6, "0"),
    name: `종목${index}`,
    market: index % 2 ? "유가" : "코스닥",
    sector: "테스트",
    closePrice: 1_000 + index,
    marketCapWon: 1_000_000_000 + index,
    tradingVolume: 100,
    priceChangePct: 1,
    flows: {
      foreign: { absoluteWon: 10, quantity: 1 },
      institution: { absoluteWon: -5, quantity: -1 },
      pension: { absoluteWon: 2, quantity: 1 },
    },
  }));
  const merged = mergeDomesticSnapshot(existing, { date: "20260724", records, failed: 0 });
  assert.equal(merged.rows.filter((row) => row[0] === "20260724").length, 1_050);
  assert.equal(merged.rows.filter((row) => row[0] === "20260723").length, 1);
  assert.equal(merged.rows.some((row) => row[2] === "old"), false);
  assert.equal(merged.automation.mode, "incremental-close");
});

test("intraday snapshot updates only live rows and preserves close history", () => {
  const existing = {
    dates: ["20260729"],
    rows: [["20260729", "005930", "삼성전자", "유가", "전자", 100, 1]],
  };
  const records = Array.from({ length: 1_050 }, (_, index) => ({
    code: String(index).padStart(6, "0"),
    name: `종목${index}`,
    market: index % 2 ? "유가" : "코스닥",
    sector: "테스트",
    closePrice: 1_000 + index,
    marketCapWon: 1_000_000_000 + index,
    tradingVolume: 100,
    priceChangePct: 1,
    flows: {
      foreign: { absoluteWon: 10, quantity: 1 },
      institution: { absoluteWon: -5, quantity: -1 },
    },
  }));
  const merged = mergeIntradaySnapshot(existing, { date: "20260730", records, failed: 2 });
  assert.equal(merged.rows, existing.rows);
  assert.equal(merged.liveSnapshot.rows.length, 1_050);
  assert.equal(merged.liveSnapshot.mode, "intraday-estimate");
  assert.equal(merged.automation.mode, "intraday-estimate");
  assert.equal(merged.automation.failed, 2);
});

test("ETF snapshot keeps only the latest 23 dates", () => {
  const previous = Array.from({ length: 23 }, (_, index) => [
    `202606${String(index + 1).padStart(2, "0")}`, "069500", "KODEX 200", "기타 국내", 1, 1, 1,
  ]);
  const snapshots = Array.from({ length: 110 }, (_, index) => ({
    date: "20260724",
    code: String(100000 + index),
    name: `ETF${index}`,
    category: "기타 국내",
    listedShares: 10,
    referencePrice: 1_000,
    marketCapWon: 10_000,
  }));
  const merged = mergeEtfSnapshots(previous, snapshots);
  assert.equal(new Set(merged.map((row) => row[0])).size, 23);
  assert.equal(merged.filter((row) => row[0] === "20260724").length, 110);
});

test("short balance snapshots replace exact dates and preserve availability", () => {
  const existing = {
    shortBalanceDates: ["20260728"],
    shortBalanceRows: [["20260728", "005930", 10, 1_000, 0.01]],
  };
  const merged = mergeShortBalanceSnapshots(existing, [{
    date: "20260729",
    totalRecords: 2_600,
    rows: [["20260729", "005930", 20, 2_000, 0.02]],
  }]);
  assert.deepEqual(merged.dates, ["20260728", "20260729"]);
  assert.equal(merged.rows.length, 2);
  assert.deepEqual(merged.rows[0], ["20260729", "005930", 20, 2_000, 0.02]);
});
