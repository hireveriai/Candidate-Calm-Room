import assert from "node:assert/strict";
import test from "node:test";

import {
  hasUnverifiedIncompleteSpokenAnswer,
  isLikelyIncompleteSpokenAnswer,
} from "./transcriptIntegrity";

test("flags a long answer with implausibly sparse captured text", () => {
  assert.equal(
    isLikelyIncompleteSpokenAnswer({
      answer_text: "I handled the employee query and checked the payroll system",
      answer_payload: { duration: 182 },
      code_text: null,
    }),
    true
  );
});

test("flags an answer ending on a connector", () => {
  assert.equal(
    isLikelyIncompleteSpokenAnswer({
      answer_text:
        "I validated every row with the source report and discussed the exceptions with",
      answer_payload: { duration: 35 },
      code_text: null,
    }),
    true
  );
});

test("accepts a recording-verified answer even when the speaker was slow", () => {
  assert.equal(
    hasUnverifiedIncompleteSpokenAnswer({
      answer_text: "I checked each record carefully and documented every exception",
      answer_payload: {
        duration: 120,
        recording_transcript_verified_at: "2026-07-24T10:00:00.000Z",
      },
      code_text: null,
    }),
    false
  );
});

