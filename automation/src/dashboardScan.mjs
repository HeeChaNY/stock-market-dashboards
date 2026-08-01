import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAssignedJson } from "./cloudState.mjs";

export function loadLatestDashboardScan(path = "./dashboard/data.js") {
  const payload = parseAssignedJson(readFileSync(resolve(path), "utf8"), "window.FLOW_DASHBOARD_DATA");
  const columns = Array.isArray(payload.columns) ? payload.columns : [];
  const index = Object.fromEntries(columns.map((name, position) => [name, position]));
  const live = Array.isArray(payload.liveSnapshot?.rows) && payload.liveSnapshot.rows.length
    ? payload.liveSnapshot
    : null;
  const date = String(live?.date || [...(payload.dates || [])].sort().at(-1) || "");
  const sourceRows = live?.rows || (payload.rows || []).filter((row) => String(row[index.date ?? 0]) === date);
  const value = (row, name, fallback) => row[index[name] ?? fallback];
  const flow = (absoluteWon, quantity, marketCapWon) => ({
    absoluteWon: nullableNumber(absoluteWon),
    quantity: nullableNumber(quantity),
    marketCapPct: Number(marketCapWon) > 0 && nullableNumber(absoluteWon) != null
      ? Number(absoluteWon) / Number(marketCapWon) * 100
      : null,
  });
  const records = sourceRows.map((row) => {
    const marketCapWon = number(value(row, "marketCapWon", 6));
    return {
      code: String(value(row, "code", 1) || ""),
      name: String(value(row, "name", 2) || value(row, "code", 1) || ""),
      market: String(value(row, "market", 3) || ""),
      sector: String(value(row, "sector", 4) || "미분류"),
      sourceDate: date,
      closePrice: number(value(row, "closePrice", 5)),
      marketCapWon,
      tradingVolume: nullableNumber(value(row, "tradingVolume", 13)),
      priceChangePct: nullableNumber(value(row, "dailyChangePct", 14)),
      flows: {
        foreign: flow(value(row, "foreignWon", 7), value(row, "foreignQty", 8), marketCapWon),
        institution: flow(value(row, "institutionWon", 9), value(row, "institutionQty", 10), marketCapWon),
        pension: flow(value(row, "pensionWon", 11), value(row, "pensionQty", 12), marketCapWon),
      },
    };
  }).filter((record) => /^\d{6}$/.test(record.code) && record.closePrice > 0);
  if (!/^\d{8}$/.test(date) || records.length < 100) throw new Error(`최근 대시보드 데이터가 부족합니다: ${date || "날짜 없음"}, ${records.length}종목`);
  return {
    date,
    requestedDate: date,
    createdAt: live?.updatedAt || payload.generatedAt || new Date(0).toISOString(),
    total: records.length,
    completed: records.length,
    failed: Number(payload.automation?.failed) || 0,
    dataMode: live ? "intraday-estimate" : "close",
    records,
  };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
