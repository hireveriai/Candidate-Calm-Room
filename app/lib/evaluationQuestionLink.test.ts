import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Regression guard for how scoring finds the planned question behind an answer.
 *
 * Questions snapshotted from a job questionnaire have question_id = NULL, so a
 * join on question_id alone never matched them and scoring ran without the
 * question's type, source or stored evaluation criteria. The asked session
 * question records interview_question_id; both scoring paths must use it.
 * These are SQL strings, so this checks the query text rather than executing it.
 */

const root = path.resolve(__dirname, "..", "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

test("live scoring links the answer to its planned question by interview_question_id", () => {
  const route = read("app/api/session/evaluate-answer/route.ts");
  assert.match(route, /candidate_iq\.interview_question_id = sq\.interview_question_id/);
  // question_id stays as a fallback for older interviews, never as the only link.
  assert.match(route, /ia\.question_id is not null and candidate_iq\.question_id = ia\.question_id/);
  assert.match(route, /reference_context->>'evaluation_criteria'/);
  assert.match(route, /resolveAnswerEvaluationPlan\(/);
});

test("recording repair scoring uses the same link and the same evaluation plan", () => {
  const repair = read("app/lib/recordingTranscriptRepair.ts");
  assert.match(repair, /iq\.interview_question_id = sq\.interview_question_id/);
  assert.match(repair, /reference_context->>'evaluation_criteria'/);
  assert.match(repair, /resolveAnswerEvaluationPlan\(/);
});
