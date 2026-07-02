function normalizeForComparison(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\b(?:veris\s*q?|candidate|answer|question|q|a)\s*\d*\s*[:\-]\s*/gi, " ")
    .replace(/[^a-z0-9+#.]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(value: string) {
  return value.split(/\s+/).filter(Boolean).length;
}

export function isLikelyInterviewerPrompt(text: string | null | undefined) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();

  return /^(?:veris\s*q?|question|q)\s*\d*\s*[:\-]/i.test(normalized);
}

export function isLikelyQuestionEcho(params: {
  transcript: string | null | undefined;
  questionText: string | null | undefined;
}) {
  const transcript = normalizeForComparison(params.transcript);
  const question = normalizeForComparison(params.questionText);

  if (!transcript || !question) {
    return false;
  }

  if (transcript === question) {
    return true;
  }

  const transcriptWords = wordCount(transcript);
  const questionWords = wordCount(question);

  return (
    questionWords >= 4 &&
    transcriptWords <= questionWords + 2 &&
    (transcript.includes(question) || question.includes(transcript))
  );
}

export function isInvalidCandidateTranscript(params: {
  transcript: string | null | undefined;
  questionText: string | null | undefined;
}) {
  return (
    isLikelyInterviewerPrompt(params.transcript) ||
    isLikelyQuestionEcho({
      transcript: params.transcript,
      questionText: params.questionText,
    })
  );
}
