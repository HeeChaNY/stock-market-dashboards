import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);

test("stock history shows KIS lending balance change before same-day short-sale trades", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL("dashboard/stocks.html", root), "utf8"),
    readFile(new URL("dashboard/assets/app.js", root), "utf8"),
    readFile(new URL("dashboard/assets/styles.css", root), "utf8"),
  ]);
  assert.ok(html.indexOf("대차 순증감") < html.indexOf("당일 공매도 거래"));
  assert.match(app, /metric=loan-transactions/);
  assert.match(app, /netChangeQuantity/);
  assert.match(app, /balanceQuantity/);
  assert.match(styles, /\.stock-history-table \{ min-width: 1120px; table-layout: fixed \}/);
  assert.match(styles, /nth-child\(2\).*width: 112px/);
});

test("stock search shows the extended price beside the KRX closing-auction price", async () => {
  const [html, app, styles] = await Promise.all([
    readFile(new URL("dashboard/stocks.html", root), "utf8"),
    readFile(new URL("dashboard/assets/app.js", root), "utf8"),
    readFile(new URL("dashboard/assets/styles.css", root), "utf8"),
  ]);
  assert.match(html, /app\.js\?v=20260916-1/);
  assert.match(app, /loadLiveQuotes\(\[r\.code\],true\)/);
  assert.match(app, /KRX 최근가격 \(KRX 동시호가 종가\)/);
  assert.match(app, /stock-price-note">\(\$\{number\(krxPrice\)\}원\)<\/span>/);
  assert.match(app, /koreaExtendedQuoteWindow\(\)&&refreshStockPrice/);
  assert.match(styles, /\.stock-price-note/);
});
