export const DASHBOARD_COLUMNS = [
  "date", "code", "name", "market", "sector", "closePrice", "marketCapWon",
  "foreignWon", "foreignQty", "institutionWon", "institutionQty",
  "pensionWon", "pensionQty", "tradingVolume", "dailyChangePct",
];

export function parseAssignedJson(source, variableName) {
  const text = String(source || "").trim();
  const prefix = `${variableName}=`;
  const offset = text.indexOf(prefix);
  if (offset < 0) throw new Error(`${variableName} 데이터 형식을 확인할 수 없습니다.`);
  const body = text.slice(offset + prefix.length).replace(/;\s*$/, "");
  return JSON.parse(body);
}

export function serializeAssignedJson(variableName, payload) {
  return `${variableName}=${JSON.stringify(payload)};\n`;
}

export function mergeDomesticSnapshot(existing, scan, { maxDates = 120 } = {}) {
  if (!Array.isArray(scan?.records) || scan.records.length < 1000) {
    throw new Error(`국내 스캔 결과가 비정상적으로 적습니다: ${scan?.records?.length || 0}종목`);
  }
  const date = String(scan.date || "");
  if (!/^\d{8}$/.test(date)) throw new Error(`국내 스캔 기준일이 올바르지 않습니다: ${date}`);

  const nextRows = scan.records.map((record) => {
    const foreign = record.flows?.foreign || {};
    const institution = record.flows?.institution || {};
    const pension = record.flows?.pension || {};
    return [
      date,
      String(record.code || ""),
      String(record.name || record.code || ""),
      String(record.market || ""),
      String(record.sector || "미분류"),
      numberOrZero(record.closePrice),
      numberOrZero(record.marketCapWon),
      nullableNumber(foreign.absoluteWon),
      nullableNumber(foreign.quantity),
      nullableNumber(institution.absoluteWon),
      nullableNumber(institution.quantity),
      nullableNumber(pension.absoluteWon),
      nullableNumber(pension.quantity),
      nullableNumber(record.tradingVolume),
      nullableNumber(record.priceChangePct),
    ];
  }).filter((row) => /^\d{6}$/.test(row[1]) && row[5] > 0);

  if (nextRows.length < 1000) {
    throw new Error(`병합 가능한 국내 스캔 결과가 비정상적으로 적습니다: ${nextRows.length}종목`);
  }

  const previousRows = Array.isArray(existing?.rows) ? existing.rows : [];
  const allDates = new Set(previousRows.map((row) => String(row[0] || "")).filter(isDate));
  allDates.add(date);
  const dates = [...allDates].sort().slice(-maxDates);
  const keep = new Set(dates);
  const rows = [
    ...nextRows,
    ...previousRows.filter((row) => String(row[0]) !== date && keep.has(String(row[0]))),
  ].sort((a, b) => String(b[0]).localeCompare(String(a[0])) || numberOrZero(b[6]) - numberOrZero(a[6]));

  return {
    ...(existing || {}),
    generatedAt: new Date().toISOString(),
    dates,
    columns: DASHBOARD_COLUMNS,
    rows,
    liveSnapshot: null,
    automation: {
      source: "github-actions",
      mode: "incremental-close",
      updatedDate: date,
      records: nextRows.length,
      failed: numberOrZero(scan.failed),
    },
  };
}

export function mergeIntradaySnapshot(existing, scan) {
  if (!Array.isArray(scan?.records) || scan.records.length < 1000) {
    throw new Error(`국내 장중 스캔 결과가 비정상적으로 적습니다: ${scan?.records?.length || 0}종목`);
  }
  const date = String(scan.date || "");
  if (!isDate(date)) throw new Error(`국내 장중 스캔 기준일이 올바르지 않습니다: ${date}`);
  const rows = scan.records.map((record) => {
    const foreign = record.flows?.foreign || {};
    const institution = record.flows?.institution || {};
    return [
      date,
      String(record.code || ""),
      String(record.name || record.code || ""),
      String(record.market || ""),
      String(record.sector || "미분류"),
      numberOrZero(record.closePrice),
      numberOrZero(record.marketCapWon),
      nullableNumber(foreign.absoluteWon),
      nullableNumber(foreign.quantity),
      nullableNumber(institution.absoluteWon),
      nullableNumber(institution.quantity),
      null,
      null,
      nullableNumber(record.tradingVolume),
      nullableNumber(record.priceChangePct),
    ];
  }).filter((row) => /^\d{6}$/.test(row[1]) && row[5] > 0);
  if (rows.length < 1000) {
    throw new Error(`병합 가능한 국내 장중 스캔 결과가 비정상적으로 적습니다: ${rows.length}종목`);
  }
  const updatedAt = new Date().toISOString();
  return {
    ...(existing || {}),
    generatedAt: updatedAt,
    liveSnapshot: {
      date,
      updatedAt,
      mode: "intraday-estimate",
      rows,
    },
    automation: {
      source: "github-actions",
      mode: "intraday-estimate",
      updatedDate: date,
      records: rows.length,
      failed: numberOrZero(scan.failed),
    },
  };
}

export function mergeEtfSnapshots(existingRows, snapshots, { maxDates = 23 } = {}) {
  if (!Array.isArray(snapshots) || !snapshots.length) return Array.isArray(existingRows) ? existingRows : [];
  const date = String(snapshots[0]?.date || "");
  if (!isDate(date)) return Array.isArray(existingRows) ? existingRows : [];
  const rows = snapshots
    .filter((row) => String(row.date) === date && /^\d{6}$/.test(String(row.code)) && numberOrZero(row.listedShares) > 0)
    .map((row) => [
      date,
      String(row.code),
      String(row.name || row.code),
      String(row.category || "기타 국내"),
      numberOrZero(row.listedShares),
      numberOrZero(row.referencePrice),
      numberOrZero(row.marketCapWon) || numberOrZero(row.listedShares) * numberOrZero(row.referencePrice),
    ]);
  if (rows.length < 100) return Array.isArray(existingRows) ? existingRows : [];
  const previous = Array.isArray(existingRows) ? existingRows : [];
  const dates = [...new Set([...previous.map((row) => String(row[0] || "")), date].filter(isDate))].sort().slice(-maxDates);
  const keep = new Set(dates);
  return [
    ...rows,
    ...previous.filter((row) => String(row[0]) !== date && keep.has(String(row[0]))),
  ].sort((a, b) => String(b[0]).localeCompare(String(a[0])) || String(a[3]).localeCompare(String(b[3])) || numberOrZero(b[6]) - numberOrZero(a[6]));
}

export function etfCategory(name) {
  const rules = [
    ["반도체", ["반도체"]],
    ["2차전지", ["2차전지", "배터리"]],
    ["자동차", ["자동차", "모빌리티"]],
    ["금융", ["은행", "금융", "증권", "보험"]],
    ["조선·기계", ["조선", "기계", "방산"]],
    ["철강·소재", ["철강", "소재", "금속"]],
    ["에너지·화학", ["에너지", "화학", "원자력"]],
    ["콘텐츠·게임", ["콘텐츠", "게임", "미디어"]],
    ["소비재", ["소비", "유통", "화장품", "K푸드", "K-푸드"]],
    ["액티브", ["액티브"]],
  ];
  const value = String(name || "");
  return rules.find(([, keywords]) => keywords.some((keyword) => value.toLowerCase().includes(keyword.toLowerCase())))?.[0] || "기타 국내";
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isDate(value) {
  return /^\d{8}$/.test(String(value || ""));
}
