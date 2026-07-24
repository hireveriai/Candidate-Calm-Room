export type RecordingRepairCandidate = {
  recording_id: string;
  file_path: string;
  transcript: string | null;
  duration_seconds: number | string | null;
};

export type RecordingTranscriptFailure = {
  recordingId: string;
  filePath: string;
  reason: string;
};

function normalizeText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function isDegenerateRecordingTranscript(value: unknown) {
  const words = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 8) {
    return words.length > 0 && new Set(words).size <= 2;
  }

  const wordCounts = new Map<string, number>();
  for (const word of words) {
    wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
  }
  const mostFrequentWord = Math.max(...wordCounts.values());
  if (mostFrequentWord / words.length >= 0.32) {
    return true;
  }

  if (words.length >= 36) {
    const shingles = new Set<string>();
    for (let index = 0; index <= words.length - 6; index += 1) {
      shingles.add(words.slice(index, index + 6).join(" "));
    }
    if (shingles.size / (words.length - 5) < 0.3) {
      return true;
    }
  }

  return false;
}

export function isReusableRecordingTranscript(value: unknown) {
  const transcript = normalizeText(value);
  if (transcript.length < 1_000 || isDegenerateRecordingTranscript(transcript)) {
    return false;
  }

  const labeledQuestionCount = (transcript.match(/\bVERIS Q\d+:/gi) ?? []).length;
  const codePunctuationCount = (transcript.match(/[{};]|=>/g) ?? []).length;
  return (
    labeledQuestionCount < 2 &&
    codePunctuationCount < Math.max(12, transcript.length * 0.02)
  );
}

function recordingPriority(recording: RecordingRepairCandidate) {
  if (isReusableRecordingTranscript(recording.transcript)) {
    return 0;
  }
  if (recording.file_path.toLowerCase().includes("-browser-")) {
    return 1;
  }
  if (recording.file_path.toLowerCase().includes("-livekit-")) {
    return 2;
  }
  return 3;
}

export function prioritizeRecordingCandidates<
  T extends RecordingRepairCandidate,
>(recordings: T[]) {
  return [...recordings].sort((left, right) => {
    const priorityDifference =
      recordingPriority(left) - recordingPriority(right);
    if (priorityDifference !== 0) {
      return priorityDifference;
    }

    return (
      Number(right.duration_seconds ?? 0) -
      Number(left.duration_seconds ?? 0)
    );
  });
}

export async function findFirstUsableRecordingTranscript<
  T extends RecordingRepairCandidate,
  R extends { text?: unknown },
>(
  recordings: T[],
  loadTranscript: (recording: T) => Promise<R>
): Promise<
  | {
      recording: T;
      transcription: R;
      transcriptText: string;
      failures: RecordingTranscriptFailure[];
    }
  | {
      recording: null;
      transcription: null;
      transcriptText: "";
      failures: RecordingTranscriptFailure[];
    }
> {
  const failures: RecordingTranscriptFailure[] = [];

  for (const recording of prioritizeRecordingCandidates(recordings)) {
    try {
      const transcription = await loadTranscript(recording);
      const transcriptText = normalizeText(transcription.text);
      const failureReason = !transcriptText
        ? "empty_transcription"
        : isDegenerateRecordingTranscript(transcriptText)
          ? "degenerate_transcription"
          : null;

      if (failureReason) {
        failures.push({
          recordingId: recording.recording_id,
          filePath: recording.file_path,
          reason: failureReason,
        });
        continue;
      }

      return {
        recording,
        transcription,
        transcriptText,
        failures,
      };
    } catch (error) {
      failures.push({
        recordingId: recording.recording_id,
        filePath: recording.file_path,
        reason:
          error instanceof Error
            ? `transcription_unavailable:${error.message.slice(0, 180)}`
            : "transcription_unavailable",
      });
    }
  }

  return {
    recording: null,
    transcription: null,
    transcriptText: "",
    failures,
  };
}
