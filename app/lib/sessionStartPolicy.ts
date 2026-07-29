export function shouldSanitizeReusedEmptyAttempt(params: {
  answerCount: number;
  recordingCount: number;
  hasStaleTerminalMetadata: boolean;
}) {
  return (
    params.answerCount === 0 &&
    params.recordingCount === 0 &&
    params.hasStaleTerminalMetadata
  );
}
