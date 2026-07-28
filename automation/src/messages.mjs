export function nonEmptyMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => String(message ?? "").trim())
    .filter(Boolean);
}

export function formatDashboardStartMessage(date, total) {
  return [
    `📥 ${date} 자동 /dashboard 전종목 수급 스캔 시작`,
    `대상 ${Number(total || 0).toLocaleString()}종목`,
    "외국인·기관·연기금등을 절대금액과 시총 대비로 집계합니다.",
  ].join("\n");
}

export function formatDashboardCompleteMessage({ date, dates, rows, excelSent, url }) {
  return [
    `✅ 누적 수급 대시보드 갱신 완료 — ${date}`,
    `${Number(dates || 0).toLocaleString()}거래일 · ${Number(rows || 0).toLocaleString()}건 저장`,
    excelSent ? "📎 같은 조회 결과로 Excel 파일도 전송했습니다." : "",
    "",
    "🔗 대시보드 열기",
    String(url || "").trim(),
  ].filter(Boolean).join("\n");
}
