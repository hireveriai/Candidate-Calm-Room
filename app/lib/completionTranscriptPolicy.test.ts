import assert from "node:assert/strict";
import test from "node:test";

import {
  canFinalizeWithTranscriptIntegrity,
  hasCompletionEvidence,
} from "./completionTranscriptPolicy";

test("does not finalize when transcript recovery failed", () => {
  assert.equal(canFinalizeWithTranscriptIntegrity(null), false);
});

test("does not finalize while incomplete transcripts remain", () => {
  assert.equal(canFinalizeWithTranscriptIntegrity({ remainingIssues: 2 }), false);
});

test("allows finalization only after transcript integrity is clean", () => {
  assert.equal(canFinalizeWithTranscriptIntegrity({ remainingIssues: 0 }), true);
});

test("protects a fully answered candidate while recording transcription is pending", () => {
  assert.equal(
    hasCompletionEvidence({
      expected_questions: 10,
      session_questions: 10,
      answer_rows: 10,
      non_empty_answers: 8,
      completed_recordings: 1,
    }),
    true
  );
});

test("does not treat a partially asked interview as complete", () => {
  assert.equal(
    hasCompletionEvidence({
      expected_questions: 10,
      session_questions: 4,
      answer_rows: 4,
      non_empty_answers: 4,
      completed_recordings: 1,
    }),
    false
  );
});

test("does not finalize while a required closing question is unanswered", () => {
  assert.equal(
    hasCompletionEvidence({
      expected_questions: 12,
      session_questions: 12,
      answer_rows: 11,
      non_empty_answers: 11,
      completed_recordings: 1,
      required_closing_questions: 2,
      answered_required_closing_questions: 1,
    }),
    false
  );
});

test("protects the completed attempt after both closing responses are saved", () => {
  assert.equal(
    hasCompletionEvidence({
      expected_questions: 12,
      session_questions: 12,
      answer_rows: 12,
      non_empty_answers: 11,
      completed_recordings: 1,
      required_closing_questions: 2,
      answered_required_closing_questions: 2,
    }),
    true
  );
});
