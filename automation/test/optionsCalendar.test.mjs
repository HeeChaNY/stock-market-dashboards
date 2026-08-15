import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedKrxMonthlyDates = [
  "2026-01-08", "2026-02-12", "2026-03-12", "2026-04-09",
  "2026-05-14", "2026-06-11", "2026-07-09", "2026-08-13",
  "2026-09-10", "2026-10-08", "2026-11-12", "2026-12-10",
];

test("options calendar includes confirmed 2026 KRX and MSCI schedules", async () => {
  const [app, html, styles] = await Promise.all([
    readFile(new URL("../../dashboard/assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../dashboard/data.html", import.meta.url), "utf8"),
    readFile(new URL("../../dashboard/assets/styles.css", import.meta.url), "utf8"),
  ]);
  const match = app.match(/\.\.\.(\[[^\]]+\])\.map\(date=>\(\{date,type:"krxMonthly"\}\)\)/);

  assert.ok(match, "KRX monthly options date list must be present");
  assert.deepEqual(JSON.parse(match[1]), expectedKrxMonthlyDates);
  assert.match(app, /2026-05-22[^\n]+krxIndexAnnouncement/);
  assert.match(app, /2026-06-12[^\n]+krxIndexEffective/);
  assert.doesNotMatch(app, /2026-12-11[^\n]+krxIndexEffective/);
  assert.match(app, /\["2026-02-11","2026-05-13","2026-08-13","2026-11-12"\][^\n]+msciAnnouncement/);
  for (const date of ["2026-02-27", "2026-05-29", "2026-08-31", "2026-11-30"]) {
    assert.match(app, new RegExp(`${date}[^\\n]+msciEffective`));
  }
  assert.match(app, /미국\(Cboe\) 표준 옵션 만기/);
  assert.match(app, /eom:\{label:"월말 옵션 만기",short:"월말 옵션만기"/);
  assert.match(html, /2026 Cboe·KRX·MSCI/);
  assert.match(styles, /\.calendar-event\.orange/);
  assert.match(styles, /\.calendar-event\.rose/);
  assert.match(styles, /\.calendar-event\.lime/);
  assert.match(styles, /\.calendar-event \{[^}]*font-size: 10px/);
});
