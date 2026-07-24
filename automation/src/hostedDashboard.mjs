import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export async function syncHostedDashboard(config) {
  const baseUrl = String(config.hostedDashboardUrl || "").replace(/\/$/, "");
  if (!baseUrl) return null;
  if (!config.hostedDashboardSyncToken || !config.hostedDashboardAuthToken) {
    throw new Error("호스팅 대시보드 인증 설정이 비어 있습니다.");
  }

  const source = readFileSync(resolve(config.dashboardDataFile), "utf8").trim();
  const separator = source.indexOf("=");
  if (separator < 0) throw new Error("대시보드 데이터 파일 형식이 올바르지 않습니다.");
  const body = source.slice(separator + 1).replace(/;\s*$/, "");
  JSON.parse(body);

  const response = await fetch(`${baseUrl}/api/sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dashboard-sync-token": config.hostedDashboardSyncToken,
      "OAI-Sites-Authorization": `Bearer ${config.hostedDashboardAuthToken}`,
    },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.error || `호스팅 대시보드 업로드 실패: HTTP ${response.status}`);
  return { ...payload, url: `${baseUrl}/dashboard/index.html` };
}

export async function syncHostedGlobalMarkets(config, payload) {
  const baseUrl = String(config.hostedGlobalUrl || "").replace(/\/$/, "");
  if (!baseUrl) return null;
  if (!config.hostedGlobalSyncToken || !config.hostedGlobalAuthToken) {
    throw new Error("글로벌 사이트 인증 설정이 비어 있습니다.");
  }
  const body = JSON.stringify(payload);
  const response = await fetch(`${baseUrl}/api/sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-global-sync-token": config.hostedGlobalSyncToken,
      "OAI-Sites-Authorization": `Bearer ${config.hostedGlobalAuthToken}`,
    },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `글로벌 대시보드 업로드 실패: HTTP ${response.status}`);
  return { ...result, url: `${baseUrl}/index.html` };
}
