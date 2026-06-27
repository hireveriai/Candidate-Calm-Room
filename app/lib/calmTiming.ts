export const MAX_ANSWER_TIME = 3 * 60 * 1000;
export const FINAL_ANSWER_GRACE_MS = 8 * 60 * 1000;

type SessionTiming = {
  ends_at: Date | string | null;
};

type SessionQuestionTiming = {
  asked_at: Date | string | null;
};

export function canAskNextQuestion(session: SessionTiming) {
  return Boolean(session.ends_at) && new Date() < new Date(session.ends_at as Date | string);
}

export function canSubmitAnswer(
  session: SessionTiming,
  sessionQuestion: SessionQuestionTiming,
  options: { allowFinalGrace?: boolean } = {}
) {
  if (!session.ends_at || !sessionQuestion.asked_at) {
    return false;
  }

  const now = new Date();
  const askedAt = new Date(sessionQuestion.asked_at);
  const endsAt = new Date(session.ends_at);

  const answerLimitMs = options.allowFinalGrace
    ? Math.max(MAX_ANSWER_TIME, FINAL_ANSWER_GRACE_MS)
    : MAX_ANSWER_TIME;

  return askedAt <= endsAt && now.getTime() - askedAt.getTime() <= answerLimitMs;
}

export function canSubmitCodingAnswer(session: SessionTiming) {
  if (!session.ends_at) {
    return false;
  }

  const now = Date.now();
  const endsAt = new Date(session.ends_at).getTime();

  return now <= endsAt + FINAL_ANSWER_GRACE_MS;
}

export function getRemainingSessionMs(session: SessionTiming) {
  if (!session.ends_at) {
    return 0;
  }

  return Math.max(0, new Date(session.ends_at).getTime() - Date.now());
}
