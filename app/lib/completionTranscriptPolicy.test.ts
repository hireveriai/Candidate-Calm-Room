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
      captured_answer_rows: 10,
      completed_recordings: 1,
      recording_evidence_rows: 1,
    }),
    true
  );
});

test("completes a mobile 12-of-12 interview while recording-backed transcripts are pending", () => {
  assert.equal(
    hasCompletionEvidence({
      expected_questions: 12,
      session_questions: 12,
      answer_rows: 12,
      non_empty_answers: 0,
      captured_answer_rows: 12,
      completed_recordings: 0,
      recording_evidence_rows: 2,
      required_closing_questions: 2,
      answered_required_closing_questions: 2,
    }),
    true
  );
});

test("does not trust pending mobile answer rows without recording evidence", () => {
  assert.equal(
    hasCompletionEvidence({
      expected_questions: 12,
      session_questions: 12,
      answer_rows: 12,
      non_empty_answers: 0,
      captured_answer_rows: 12,
      completed_recordings: 0,
      recording_evidence_rows: 0,
      required_closing_questions: 2,
      answered_required_closing_questions: 2,
    }),
    false
  );
});

test("does not complete when one of twelve mobile answers has no capture evidence", () => {
  assert.equal(
    hasCompletionEvidence({
      expected_questions: 12,
      session_questions: 12,
      answer_rows: 12,
      non_empty_answers: 0,
      captured_answer_rows: 11,
      completed_recordings: 0,
      recording_evidence_rows: 2,
      required_closing_questions: 2,
      answered_required_closing_questions: 2,
    }),
    false
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

test("rejects Megha regression: three answers cannot finalize a twelve-question interview", () => {
  assert.equal(
    hasCompletionEvidence({
      expected_questions: 12,
      session_questions: 3,
      answer_rows: 3,
      non_empty_answers: 3,
      completed_recordings: 2,
      required_closing_questions: 0,
      answered_required_closing_questions: 0,
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
