import assert from "node:assert/strict";
import test from "node:test";

import { isAuthorizedCronRequest } from "@/app/lib/cronAuth";

const request = (authorization?: string) =>
  new Request("https://example.test/api/interview/watchdog", {
    headers: authorization ? { authorization } : {},
  });

test("accepts only the configured bearer secret", () => {
  assert.equal(isAuthorizedCronRequest(request("Bearer s3cret"), "s3cret"), true);
  assert.equal(isAuthorizedCronRequest(request("Bearer wrong"), "s3cret"), false);
  assert.equal(isAuthorizedCronRequest(request(), "s3cret"), false);
  assert.equal(isAuthorizedCronRequest(request("s3cret"), "s3cret"), false);
});

test("refuses every caller when no secret is configured", () => {
  assert.equal(isAuthorizedCronRequest(request(), undefined), false);
  assert.equal(isAuthorizedCronRequest(request("Bearer "), ""), false);
  assert.equal(isAuthorizedCronRequest(request("Bearer undefined"), undefined), false);
});

test("ignores surrounding whitespace in the configured secret", () => {
  assert.equal(isAuthorizedCronRequest(request("Bearer s3cret"), "  s3cret\n"), true);
});
