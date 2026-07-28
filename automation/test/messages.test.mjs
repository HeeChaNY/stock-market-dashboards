import test from "node:test";
import assert from "node:assert/strict";
import { nonEmptyMessages } from "../src/messages.mjs";

test("Telegram messages omit empty formatter output", () => {
  assert.deepEqual(
    nonEmptyMessages([" 첫 번째 ", "", "   ", null, undefined, "두 번째"]),
    ["첫 번째", "두 번째"],
  );
});

test("Telegram messages tolerate non-array formatter output", () => {
  assert.deepEqual(nonEmptyMessages(null), []);
});
