const MIN_SPOKEN_ANSWER_MS = 10_000;
const COMPLETED_ANSWER_SILENCE_MS = 7_000;
const MIN_VOICE_ACTIVITY_FRAMES = 12;

export function shouldAdvanceSpokenAnswer(params: {
  now: number;
  questionStartedAt: number | null;
  lastCandidateActivityAt: number;
  voiceActivityFrames: number;
  transcript: string;
}) {
  if (
    !params.questionStartedAt ||
    params.now - params.questionStartedAt < MIN_SPOKEN_ANSWER_MS
  ) {
    return false;
  }

  const hasCandidateResponse =
    params.transcript.trim().length >= 3 ||
    params.voiceActivityFrames >= MIN_VOICE_ACTIVITY_FRAMES;

  if (!hasCandidateResponse || params.lastCandidateActivityAt <= 0) {
    return false;
  }

  return (
    params.now - params.lastCandidateActivityAt >=
    COMPLETED_ANSWER_SILENCE_MS
  );
}
