import assert from "node:assert/strict";
import test from "node:test";

import { shouldSanitizeReusedEmptyAttempt } from "./sessionStartPolicy";
import { isProvisionalPageLifecycleSource } from "./interviewSessionReliability";

test("sanitizes an empty reused attempt carrying stale timeout metadata", () => {
  assert.equal(
    shouldSanitizeReusedEmptyAttempt({
      answerCount: 0,
      recordingCount: 0,
      hasStaleTerminalMetadata: true,
    }),
    true,
  );
});

test("does not reset a legitimate reconnect with persisted interview evidence", () => {
  assert.equal(
    shouldSanitizeReusedEmptyAttempt({
      answerCount: 1,
      recordingCount: 1,
      hasStaleTerminalMetadata: true,
    }),
    false,
  );
});

test("does not restart the timer for a clean empty page refresh", () => {
  assert.equal(
    shouldSanitizeReusedEmptyAttempt({
      answerCount: 0,
      recordingCount: 0,
      hasStaleTerminalMetadata: false,
    }),
    false,
  );
});

test("treats a browser page lifecycle event as provisional", () => {
  assert.equal(isProvisionalPageLifecycleSource("browser_pagehide"), true);
  assert.equal(isProvisionalPageLifecycleSource("browser_offline"), false);
});
