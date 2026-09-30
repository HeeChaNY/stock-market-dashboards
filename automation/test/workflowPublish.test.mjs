import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("domestic workflow rebases and retries a rejected data push safely", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/refresh-domestic.yml", import.meta.url), "utf8");
  assert.match(workflow, /for attempt in 1 2 3/);
  assert.match(workflow, /git fetch origin main/);
  assert.match(workflow, /git rebase origin\/main/);
  assert.match(workflow, /git rebase --abort/);
  assert.match(workflow, /git push origin HEAD:main/);
});
