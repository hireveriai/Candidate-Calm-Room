import assert from "node:assert/strict";
import test from "node:test";

import { ROLE_NEUTRAL_OPENING_QUESTION } from "./interviewOpening";

test("uses the approved role-neutral opening question", () => {
  assert.equal(
    ROLE_NEUTRAL_OPENING_QUESTION,
    "Please walk me through your experience, including your current or most recent role, your main responsibilities, key achievements, and the kind of work you have handled."
  );
});
