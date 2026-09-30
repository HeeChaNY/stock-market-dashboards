import test from "node:test";
import assert from "node:assert/strict";
import { KisClient } from "../src/kisClient.mjs";

test("token issuance rate limit waits once and then succeeds", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requests = 0;
  const waits = [];
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) return jsonResponse(403, { error_description: "접근토큰 발급 잠시 후 다시 시도하세요(1분당 1회)" });
    return jsonResponse(200, { access_token: "token", expires_in: 82800 });
  };
  const client = makeClient({ sleep: async (milliseconds) => waits.push(milliseconds) });

  assert.equal(await client.getToken(), "token");
  assert.equal(await client.getToken(), "token");
  assert.equal(requests, 2);
  assert.deepEqual(waits, [65_000]);
});

test("ordinary authentication errors fail immediately", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return jsonResponse(401, { error_code: "EGW00123", error_description: "invalid app key" });
  };
  const client = makeClient({ sleep: async () => assert.fail("must not wait") });

  await assert.rejects(() => client.getToken(), Object.assign(new Error("invalid app key"), { code: "EGW00123" }));
  assert.equal(requests, 1);
});

function makeClient(overrides = {}) {
  return new KisClient({
    kisBaseUrl: "https://example.test",
    kisAppKey: "key",
    kisAppSecret: "secret",
    requestsPerSecond: 8,
    ...overrides,
  });
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
