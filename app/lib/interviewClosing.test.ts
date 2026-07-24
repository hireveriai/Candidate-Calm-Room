import assert from "node:assert/strict";
import test from "node:test";

import {
  CANDIDATE_CLOSING_STAGE,
  getNextRequiredClosingQuestion,
  inferCandidateCareerStage,
  MOTIVATION_CLOSING_STAGE,
} from "./interviewClosing";

test("adapts motivation wording only when profile evidence is clear", () => {
  assert.equal(
    inferCandidateCareerStage({ resumeText: "Software Engineer, Acme, Jan 2024 - Present" }),
    "employed"
  );
  assert.equal(
    inferCandidateCareerStage({ resumeText: "Recent graduate and fresher seeking first role" }),
    "fresher"
  );
  assert.equal(
    inferCandidateCareerStage({ candidateExperience: "Returning to work after a career break" }),
    "returning"
  );
  assert.equal(inferCandidateCareerStage({ claimedExperienceYears: 4 }), "unknown");
});

test("enforces motivation then candidate statement then completion", () => {
  const first = getNextRequiredClosingQuestion({
    askedQuestions: [],
    careerStage: "unknown",
  });
  assert.equal(first?.stage, MOTIVATION_CLOSING_STAGE);

  const second = getNextRequiredClosingQuestion({
    askedQuestions: [
      {
        questionKind: "closing",
        sourceContext: { ending_stage: MOTIVATION_CLOSING_STAGE },
      },
    ],
    careerStage: "unknown",
  });
  assert.equal(second?.stage, CANDIDATE_CLOSING_STAGE);

  const complete = getNextRequiredClosingQuestion({
    askedQuestions: [
      {
        questionKind: "closing",
        sourceContext: { ending_stage: MOTIVATION_CLOSING_STAGE },
      },
      {
        questionKind: "closing",
        sourceContext: { ending_stage: CANDIDATE_CLOSING_STAGE },
      },
    ],
    careerStage: "unknown",
  });
  assert.equal(complete, null);
});
