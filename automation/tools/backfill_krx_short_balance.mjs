import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { mergeShortBalanceSnapshots, parseAssignedJson, serializeAssignedJson } from "../src/cloudState.mjs";
import { fetchKrxShortBalanceSnapshots } from "../src/krxShortBalance.mjs";

const path = resolve(process.env.DASHBOARD_DATA_FILE || "./dashboard/data.js");
const dashboard = parseAssignedJson(readFileSync(path, "utf8"), "window.FLOW_DASHBOARD_DATA");
const result = await fetchKrxShortBalanceSnapshots({
  candidateDates: dashboard.dates,
  knownDates: process.env.FORCE_REFRESH === "1" ? [] : dashboard.shortBalanceDates,
  maxBackfillDates: Number(process.env.KRX_SHORT_BALANCE_BACKFILL_DATES || 31),
});
const merged = mergeShortBalanceSnapshots(dashboard, result.snapshots);
dashboard.shortBalanceDates = merged.dates;
dashboard.shortBalanceRows = merged.rows;
dashboard.shortBalanceLatestAvailableDate = result.latestAvailableDate;
dashboard.generatedAt = new Date().toISOString();
writeFileSync(path, serializeAssignedJson("window.FLOW_DASHBOARD_DATA", dashboard), "utf8");
console.log(JSON.stringify({
  latestAvailableDate: result.latestAvailableDate,
  fetchedDates: result.snapshots.map((snapshot) => snapshot.date),
  storedDates: merged.dates.length,
  storedRows: merged.rows.length,
}));
