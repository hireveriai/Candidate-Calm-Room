import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSafeClarificationFallback,
  isClarificationRequest,
  sanitizeClarifiedQuestion,
} from "./interviewClarification";

test("detects common direct clarification requests", () => {
  [
    "I don't understand the question.",
    "Could you explain that?",
    "What do you mean?",
    "Can you put that in simpler words?",
    "I am not able to understand this question",
    "I'm not sure what you're asking.",
  ].forEach((utterance) => assert.equal(isClarificationRequest(utterance), true));
});

test("does not treat a substantive retrospective statement as a request", () => {
  assert.equal(
    isClarificationRequest(
      "At first I did not understand the question, but then I checked the customer requirements and completed the work."
    ),
    false
  );
  assert.equal(
    isClarificationRequest(
      "I do not understand why the database failed, so I would inspect the logs and compare the replicas."
    ),
    false
  );
});

test("provides a global role-safe deterministic fallback", () => {
  assert.equal(
    buildSafeClarificationFallback(
      "Describe your approach to collaborating with stakeholders and prioritizing outcomes?"
    ),
    "Tell me about your way of working with people involved and deciding which results matter most?"
  );
});

test("sanitizes empty and non-question model output", () => {
  assert.match(sanitizeClarifiedQuestion("", "How do you ensure quality?"), /make sure quality\?/i);
  assert.equal(
    sanitizeClarifiedQuestion("How would you make the process easier to follow", "Original?"),
    "How would you make the process easier to follow?"
  );
});
