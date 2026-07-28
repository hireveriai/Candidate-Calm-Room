export type TranscriptIntegrityDecision = {
  remainingIssues: number;
  repairedAnswers?: number;
} | null;

export function canFinalizeWithTranscriptIntegrity(
  integrity: TranscriptIntegrityDecision
) {
  return Boolean(integrity && integrity.remainingIssues === 0);
}

export type CompletionEvidence = {
  expected_questions: number | null;
  session_questions: number;
  answer_rows: number;
  non_empty_answers: number;
  completed_recordings: number;
  captured_answer_rows?: number;
  recording_evidence_rows?: number;
  required_closing_questions?: number;
  answered_required_closing_questions?: number;
  closing_sequence_complete?: boolean;
};

/**
 * Protect a candidate who completed the interview from being marked abandoned
 * while recording-backed transcription is still running.
 */
export function hasCompletionEvidence(evidence: CompletionEvidence | null) {
  if (!evidence) {
    return false;
  }

  const closingSequenceComplete =
    evidence.closing_sequence_complete === true;
  const expectedQuestions = closingSequenceComplete
    ? Math.max(evidence.session_questions, 1)
    : Math.max(evidence.expected_questions ?? 0, 1);
  const askedEnough = evidence.session_questions >= expectedQuestions;
  const capturedAnswerRows = Math.max(
    evidence.captured_answer_rows ?? evidence.non_empty_answers,
    0
  );
  const recordingEvidenceRows = Math.max(
    evidence.recording_evidence_rows ?? evidence.completed_recordings,
    0
  );
  const answeredEnough =
    evidence.non_empty_answers >= Math.max(expectedQuestions - 1, 1) ||
    (evidence.answer_rows >= expectedQuestions &&
      capturedAnswerRows >= expectedQuestions &&
      recordingEvidenceRows > 0);
  const requiredClosingQuestions = Math.max(
    evidence.required_closing_questions ?? 0,
    0
  );
  const requiredClosingAnswered =
    (evidence.answered_required_closing_questions ?? 0) >=
    requiredClosingQuestions;

  return askedEnough && answeredEnough && requiredClosingAnswered;
}
