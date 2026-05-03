export const MAX_ANSWER_TIME = 3 * 60 * 1000;

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
  sessionQuestion: SessionQuestionTiming
) {
  if (!session.ends_at || !sessionQuestion.asked_at) {
    return false;
  }

  const now = new Date();
  const askedAt = new Date(sessionQuestion.asked_at);
  const endsAt = new Date(session.ends_at);

  return askedAt <= endsAt && now.getTime() - askedAt.getTime() <= MAX_ANSWER_TIME;
}

export function getRemainingSessionMs(session: SessionTiming) {
  if (!session.ends_at) {
    return 0;
  }

  return Math.max(0, new Date(session.ends_at).getTime() - Date.now());
}
