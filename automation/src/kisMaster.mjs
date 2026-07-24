import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readJson } from "./store.mjs";

export async function ensureKisListedShares(config, date) {
  const cached = readJson(config.shareCountCacheFile);
  if (cached?.version >= 6 && cached?.updatedDate === date && Object.keys(cached.entries || {}).length > 2000 && cached.entries?.["005930"]?.marketCapWon > 0 && cached.entries?.["000660"]?.marketCapWon > 0) {
    return cached;
  }
  await runPython(config.pythonBin, [
    "automation/tools/fetch_kis_listed_shares.py",
    "--output", resolve(config.shareCountCacheFile),
  ]);
  const refreshed = readJson(config.shareCountCacheFile);
  if (!refreshed?.entries?.["005930"] || !refreshed?.entries?.["000660"]) throw new Error("KIS 종목 마스터에서 상장주수를 확인하지 못했습니다.");
  return refreshed;
}

export function filterStocksByMarketCap(stocks, entries, minimumWon) {
  return stocks.filter((stock) => Number(entries?.[stock.code]?.marketCapWon || 0) >= minimumWon);
}

function runPython(pythonBin, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pythonBin, args, { cwd: process.cwd(), windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr.trim() || `KIS master exit ${code}`)));
  });
}
