import assert from "node:assert/strict";
import test from "node:test";

import { shouldAdvanceSpokenAnswer } from "./spokenAnswerAdvancePolicy";

test("advances a spoken answer after a sustained silence", () => {
  assert.equal(
    shouldAdvanceSpokenAnswer({
      now: 20_000,
      questionStartedAt: 1_000,
      lastCandidateActivityAt: 12_000,
      voiceActivityFrames: 30,
      transcript: "I led the migration and reduced processing time.",
    }),
    true
  );
});

test("does not advance during a normal thinking pause", () => {
  assert.equal(
    shouldAdvanceSpokenAnswer({
      now: 16_000,
      questionStartedAt: 1_000,
      lastCandidateActivityAt: 12_000,
      voiceActivityFrames: 30,
      transcript: "I led the migration.",
    }),
    false
  );
});

test("does not advance before the candidate has responded", () => {
  assert.equal(
    shouldAdvanceSpokenAnswer({
      now: 30_000,
      questionStartedAt: 1_000,
      lastCandidateActivityAt: 0,
      voiceActivityFrames: 0,
      transcript: "",
    }),
    false
  );
});

test("allows recording-backed advance when voice exists but STT is empty", () => {
  assert.equal(
    shouldAdvanceSpokenAnswer({
      now: 30_000,
      questionStartedAt: 1_000,
      lastCandidateActivityAt: 20_000,
      voiceActivityFrames: 40,
      transcript: "",
    }),
    true
  );
});
