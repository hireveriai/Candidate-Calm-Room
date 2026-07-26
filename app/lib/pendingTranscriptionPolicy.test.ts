import assert from "node:assert/strict";
import test from "node:test";

import { shouldAllowPendingSpokenTranscription } from "./pendingTranscriptionPolicy";

test("allows recording fallback when voice activity was detected", () => {
  assert.equal(
    shouldAllowPendingSpokenTranscription({
      voiceActivityDetected: true,
    }),
    true
  );
});

test("allows recording fallback after browser recognition overflow", () => {
  assert.equal(
    shouldAllowPendingSpokenTranscription({
      speechRecognitionError: "transcript_limit_reached",
    }),
    true
  );
});

test("keeps strict validation when there is no answer evidence", () => {
  assert.equal(shouldAllowPendingSpokenTranscription({}), false);
});
