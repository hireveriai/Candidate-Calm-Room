import assert from "node:assert/strict";
import test from "node:test";

import { buildErrorEvent, parseSentryDsn } from "@/app/lib/errorReporting";

test("parses a Sentry DSN into the store endpoint and public key", () => {
  assert.deepEqual(parseSentryDsn("https://abc123@o4507.ingest.sentry.io/4508123"), {
    storeUrl: "https://o4507.ingest.sentry.io/api/4508123/store/",
    publicKey: "abc123",
  });
});

test("missing or malformed DSNs disable forwarding", () => {
  for (const dsn of [undefined, null, "", "not a url", "https://o1.ingest.sentry.io/123", "https://key@o1.ingest.sentry.io/"]) {
    assert.equal(parseSentryDsn(dsn), null, String(dsn));
  }
});

test("error events carry the route pattern, never a concrete path or request data", () => {
  const event = buildErrorEvent(
    "calm-room",
    Object.assign(new Error("boom"), { digest: "d1" }),
    { method: "POST" },
    { routePath: "/interview/[token]", routeType: "render" },
  );

  assert.equal(event.route, "/interview/[token]");
  assert.equal(event.method, "POST");
  assert.equal(event.digest, "d1");
  assert.equal(event.message, "boom");
  assert.ok(!("path" in event) && !("headers" in event) && !("body" in event));
});

test("non-Error throws are still reported", () => {
  assert.equal(buildErrorEvent("x", "plain string").message, "plain string");
});
