import { existsSync } from "node:fs";

const KRX_SHORT_BALANCE_URL = "https://data.krx.co.kr/comm/srt/srtLoader/index.cmd?screenId=MDCSTAT305";

export async function fetchKrxShortBalanceSnapshots({ candidateDates = [], knownDates = [], maxBackfillDates = 31, headless = true, timeoutMs = 45_000 } = {}) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless, executablePath: resolveChromiumExecutable(chromium) });
  const context = await browser.newContext({
    locale: "ko-KR",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  try {
    await page.goto(KRX_SHORT_BALANCE_URL, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.locator("#MDCSTAT305_FORM").waitFor();
    await page.locator(".CI-GRID-BODY-TABLE tbody tr").first().waitFor({ timeout: timeoutMs });
    const latestAvailableDate = await page.locator("#trdDd").inputValue();
    if (!isDate(latestAvailableDate)) throw new Error(`KRX 공매도 잔고 최신일을 확인할 수 없습니다: ${latestAvailableDate}`);
    const known = new Set(knownDates.map(String));
    const targets = [...new Set(candidateDates.map(String).filter(isDate))]
      .filter((date) => date <= latestAvailableDate && !known.has(date)).sort()
      .slice(-Math.max(1, Number(maxBackfillDates) || 31));
    const snapshots = [];
    for (const date of targets) {
      const rows = [];
      let totalRecords = 0;
      for (const marketCode of ["1", "2"]) {
        const responsePromise = page.waitForResponse((response) => {
          if (!response.url().includes("/comm/bldAttendant/getJsonData.cmd")) return false;
          const body = response.request().postData() || "";
          return body.includes("MDCSTAT30501") || response.url().includes("MDCSTAT30501");
        }, { timeout: timeoutMs });
        await page.locator(`#mktTpCd_${marketCode === "1" ? "0" : "1"}`).check({ force: true });
        await page.locator("#trdDd").fill(date);
        await page.locator("#jsSearchButton").click();
        const response = await responsePromise;
        if (!response.ok()) throw new Error(`KRX 공매도 잔고 조회 실패: HTTP ${response.status()} (${date}/${marketCode})`);
        const payload = await response.json();
        const records = payload.OutBlock_1 || payload.output || [];
        totalRecords += records.length;
        rows.push(...records.map((record) => normalizeRecord(date, record)).filter(Boolean));
      }
      if (totalRecords < 1_000) {
        console.warn(`KRX short balance skipped: ${date} returned only ${totalRecords} records`);
        continue;
      }
      snapshots.push({ date, rows, totalRecords });
      console.log(JSON.stringify({ stage: "krx-short-balance", date, rows: rows.length, totalRecords }));
    }
    return { latestAvailableDate, snapshots };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function resolveChromiumExecutable(chromium) {
  const candidates = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean);
  return candidates.find((path) => existsSync(path)) || chromium.executablePath();
}

function normalizeRecord(date, record) {
  const code = String(record.ISU_SRT_CD || record.ISU_CD || "").trim();
  if (!/^\d{6}$/.test(code)) return null;
  const balanceQty = number(record.BAL_QTY), balanceWon = number(record.BAL_AMT), balanceRatio = number(record.BAL_RTO);
  if (balanceQty <= 0 && balanceWon <= 0) return null;
  return [date, code, balanceQty, balanceWon, balanceRatio];
}

function number(value) { const parsed = Number(String(value ?? "0").replaceAll(",", "")); return Number.isFinite(parsed) ? parsed : 0; }
function isDate(value) { return /^\d{8}$/.test(String(value || "")); }
