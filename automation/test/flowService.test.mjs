import test from "node:test";
import assert from "node:assert/strict";
import {
  dashboardConfirmedFlowStatus,
  dashboardFlowPhase,
  isDashboardIntradayAvailable,
  resolveLatestCompletedFlowDate,
} from "../src/flowService.mjs";

test("07:59 KST selects the previous confirmed trading day", async () => {
  const calls = [];
  const client = dailyClient(calls, { 20260929: [dailyRow("20260929")] });
  const now = new Date("2026-09-29T22:59:00.000Z");

  assert.equal(dashboardFlowPhase(now, true), "previous-close");
  assert.equal(await resolveLatestCompletedFlowDate(client, "20260930", now), "20260929");
  assert.deepEqual(calls, ["20260929"]);
});

test("08:00 KST uses intraday data when a current estimate exists", async () => {
  const now = new Date("2026-09-29T23:00:00.000Z");
  const client = intradayClient({ quoteDate: "20260930", estimateCode: "0800" });

  assert.equal(dashboardFlowPhase(now, true), "intraday-first");
  assert.equal(await isDashboardIntradayAvailable(client, "20260930", now, ["005930"]), true);
});

test("08:00 KST rejects a stale intraday estimate and falls back to the previous close", async () => {
  const now = new Date("2026-09-29T23:00:00.000Z");
  const client = intradayClient({ quoteDate: "20260929", estimateCode: "1430" });

  assert.equal(await isDashboardIntradayAvailable(client, "20260930", now, ["005930"]), false);
});

test("weekends and holidays always select the previous-close phase", () => {
  assert.equal(dashboardFlowPhase(new Date("2026-10-03T03:00:00.000Z"), false), "previous-close");
  assert.equal(dashboardFlowPhase(new Date("2026-09-30T03:00:00.000Z"), false), "previous-close");
});

test("Monday dawn resolves Friday rather than relabeling it as Monday", async () => {
  const calls = [];
  const client = dailyClient(calls, { 20261002: [dailyRow("20261002")] });
  const now = new Date("2026-10-04T22:00:00.000Z");

  assert.equal(await resolveLatestCompletedFlowDate(client, "20261005", now), "20261002");
  assert.deepEqual(calls, ["20261004", "20261003", "20261002"]);
});

test("after 15:30 a missing same-day close is a normal waiting state", async () => {
  const calls = [];
  const client = dailyClient(calls, { 20260930: [dailyRow("20260929")] });
  const now = new Date("2026-09-30T06:31:00.000Z");
  const sourceDate = await resolveLatestCompletedFlowDate(client, "20260930", now);

  assert.equal(sourceDate, "20260929");
  assert.equal(dashboardConfirmedFlowStatus("today-close", "20260930", sourceDate), "waiting");
});

function dailyClient(calls, rowsByCandidate) {
  return {
    async investorDaily(_symbol, candidate) {
      calls.push(candidate);
      return { output2: rowsByCandidate[candidate] || [] };
    },
  };
}

function dailyRow(date) {
  return { stck_bsop_date: date };
}

function intradayClient({ quoteDate, estimateCode }) {
  return {
    async investorTrendEstimate() {
      return { output2: [{ bsop_hour_gb: estimateCode, frgn_fake_ntby_qty: "10", orgn_fake_ntby_qty: "20" }] };
    },
    async currentPrice() {
      return {
        output: {
          stck_bsop_date: quoteDate,
          stck_prpr: "70000",
          lstn_stcn: "1000000",
          acml_vol: "100",
          prdy_vrss: "100",
          prdy_vrss_sign: "2",
          prdy_ctrt: "0.14",
        },
      };
    },
  };
}
