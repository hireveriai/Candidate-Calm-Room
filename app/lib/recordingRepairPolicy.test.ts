import assert from "node:assert/strict";
import test from "node:test";

import {
  findFirstUsableRecordingTranscript,
  prioritizeRecordingCandidates,
} from "./recordingRepairPolicy";

const browserRecording = {
  recording_id: "browser",
  file_path: "recordings/candidate-browser-answer.webm",
  transcript: null,
  duration_seconds: 1_600,
};

const liveKitRecording = {
  recording_id: "livekit",
  file_path: "recordings/candidate-livekit-room.mp4",
  transcript: Array.from(
    { length: 12 },
    (_, index) =>
      `VERIS Q${index + 1}: Please answer question ${index + 1} with relevant details.`
  ).join(" "),
  duration_seconds: 1_550,
};

test("prefers the candidate browser recording over a labeled LiveKit summary", () => {
  const prioritized = prioritizeRecordingCandidates([
    liveKitRecording,
    browserRecording,
  ]);

  assert.equal(prioritized[0].recording_id, "browser");
  assert.equal(prioritized[1].recording_id, "livekit");
});

test("falls back to the next recording after a degenerate transcription", async () => {
  const result = await findFirstUsableRecordingTranscript(
    [browserRecording, liveKitRecording],
    async (recording) => {
      if (recording.recording_id === "browser") {
        return {
          text: "yes yes yes yes yes yes yes yes yes yes yes yes yes yes yes",
        };
      }

      return {
        text: Array.from(
          { length: 45 },
          (_, index) =>
            `At stage ${index + 1}, I coordinated the hiring process with managers and candidates.`
        ).join(" "),
      };
    }
  );

  assert.equal(result.recording?.recording_id, "livekit");
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].reason, "degenerate_transcription");
});

test("continues after a source cannot be transcribed", async () => {
  const result = await findFirstUsableRecordingTranscript(
    [browserRecording, liveKitRecording],
    async (recording) => {
      if (recording.recording_id === "browser") {
        throw new Error("unsupported media");
      }

      return {
        text: Array.from(
          { length: 45 },
          (_, index) =>
            `During example ${index + 1}, I handled documentation, scheduling, and stakeholder follow-up.`
        ).join(" "),
      };
    }
  );

  assert.equal(result.recording?.recording_id, "livekit");
  assert.match(result.failures[0].reason, /^transcription_unavailable:/);
});
