import assert from "node:assert/strict";
import test from "node:test";

import { ROLE_NEUTRAL_OPENING_QUESTION } from "./interviewOpening";
import { requiresOpeningFollowUp } from "./openingFollowUpPolicy";

test("requires the first follow-up after the role-neutral opening", () => {
  assert.equal(
    requiresOpeningFollowUp([
      { content: ROLE_NEUTRAL_OPENING_QUESTION, questionKind: "core" },
    ]),
    true
  );
});

test("requires a second consecutive follow-up after the opening", () => {
  assert.equal(
    requiresOpeningFollowUp([
      { content: ROLE_NEUTRAL_OPENING_QUESTION, questionKind: "core" },
      { content: "What achievement are you most proud of?", questionKind: "follow_up" },
    ]),
    true
  );
});

test("moves to the interview plan after two opening follow-ups", () => {
  assert.equal(
    requiresOpeningFollowUp([
      { content: ROLE_NEUTRAL_OPENING_QUESTION, questionKind: "core" },
      { content: "What achievement are you most proud of?", questionKind: "follow_up" },
      { content: "What was your personal contribution?", questionKind: "follow_up" },
    ]),
    false
  );
});

test("does not retrofit opening probes after another core question", () => {
  assert.equal(
    requiresOpeningFollowUp([
      { content: ROLE_NEUTRAL_OPENING_QUESTION, questionKind: "core" },
      { content: "Describe a production incident.", questionKind: "core" },
    ]),
    false
  );
});
