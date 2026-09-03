import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateIntegrityProgress,
  findFirstUsableRecordingTranscript,
  isDegenerateRecordingTranscript,
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

test("rejects an answer duplicated end-to-end by speech recognition", () => {
  const answer =
    "I communicate with employees, review the system record, document the correction, obtain approval, and verify the next payroll cycle";

  assert.equal(
    isDegenerateRecordingTranscript(`${answer} ${answer}`),
    true
  );
});

test("gives up after repeated passes that resolve nothing", () => {
  const base = {
    remainingIssues: 4,
    previousRemainingIssues: 4,
    repairedAnswers: 0,
    budgetDeferred: false,
    maxUnproductivePasses: 3,
  };

  const first = evaluateIntegrityProgress({ ...base, priorUnproductivePasses: 0 });
  assert.equal(first.unproductivePasses, 1);
  assert.equal(first.terminal, false);

  const second = evaluateIntegrityProgress({ ...base, priorUnproductivePasses: 1 });
  assert.equal(second.terminal, false);

  const third = evaluateIntegrityProgress({ ...base, priorUnproductivePasses: 2 });
  assert.equal(third.unproductivePasses, 3);
  assert.equal(third.terminal, true);
});

test("a pass that reduces the issue count resets the give-up counter", () => {
  const result = evaluateIntegrityProgress({
    remainingIssues: 2,
    previousRemainingIssues: 5,
    repairedAnswers: 0,
    priorUnproductivePasses: 2,
    budgetDeferred: false,
    maxUnproductivePasses: 3,
  });

  assert.equal(result.unproductivePasses, 0);
  assert.equal(result.terminal, false);
});

test("recovering an answer counts as progress even when issues remain level", () => {
  const result = evaluateIntegrityProgress({
    remainingIssues: 3,
    previousRemainingIssues: 3,
    repairedAnswers: 1,
    priorUnproductivePasses: 2,
    budgetDeferred: false,
    maxUnproductivePasses: 3,
  });

  assert.equal(result.unproductivePasses, 0);
  assert.equal(result.terminal, false);
});

test("a budget-deferred pass is never held against the attempt", () => {
  const result = evaluateIntegrityProgress({
    remainingIssues: 6,
    previousRemainingIssues: 6,
    repairedAnswers: 0,
    priorUnproductivePasses: 2,
    budgetDeferred: true,
    maxUnproductivePasses: 3,
  });

  assert.equal(result.unproductivePasses, 0);
  assert.equal(result.terminal, false);
});

test("a clean attempt never becomes terminal", () => {
  const result = evaluateIntegrityProgress({
    remainingIssues: 0,
    previousRemainingIssues: 0,
    repairedAnswers: 0,
    priorUnproductivePasses: 9,
    budgetDeferred: false,
    maxUnproductivePasses: 3,
  });

  assert.equal(result.terminal, false);
});

test("the first pass on an attempt is never unproductive", () => {
  const result = evaluateIntegrityProgress({
    remainingIssues: 7,
    previousRemainingIssues: null,
    repairedAnswers: 0,
    priorUnproductivePasses: 0,
    budgetDeferred: false,
    maxUnproductivePasses: 3,
  });

  assert.equal(result.unproductivePasses, 0);
  assert.equal(result.terminal, false);
});
