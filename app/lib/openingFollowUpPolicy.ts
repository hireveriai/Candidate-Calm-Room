import { ROLE_NEUTRAL_OPENING_QUESTION } from "./interviewOpening";

type AskedQuestion = {
  content: string | null | undefined;
  questionKind: string | null | undefined;
};

function normalize(value: string | null | undefined) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function isRoleNeutralOpeningQuestion(
  value: string | null | undefined
) {
  const question = normalize(value);
  const approvedOpening = normalize(ROLE_NEUTRAL_OPENING_QUESTION);

  return (
    question === approvedOpening ||
    (question.includes("walk me through your experience") &&
      question.includes("main responsibilities") &&
      question.includes("key achievements"))
  );
}

/**
 * The role-neutral opening is a deliberate three-question conversation:
 * overview -> probe 1 -> probe 2. General adaptive scoring must not skip
 * these probes merely because the overview answer was already detailed.
 */
export function requiresOpeningFollowUp(
  askedQuestions: AskedQuestion[],
  requiredFollowUps = 2
) {
  if (
    requiredFollowUps <= 0 ||
    !isRoleNeutralOpeningQuestion(askedQuestions[0]?.content)
  ) {
    return false;
  }

  const questionsAfterOpening = askedQuestions.slice(1);
  if (
    questionsAfterOpening.some(
      (question) => question.questionKind !== "follow_up"
    )
  ) {
    return false;
  }

  return questionsAfterOpening.length < requiredFollowUps;
}
