export function shouldAllowPendingSpokenTranscription(params: {
  explicitlyRequested?: boolean;
  voiceActivityDetected?: boolean;
  speechRecognitionError?: string | null;
}) {
  return Boolean(
    params.explicitlyRequested ||
      params.voiceActivityDetected ||
      params.speechRecognitionError?.trim()
  );
}
