import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCandidateRecordingFilePath,
  sanitizeRecordingCandidateName,
} from "./recordingFileNames";

test("creates a safe readable candidate recording name", () => {
  assert.equal(sanitizeRecordingCandidateName("  Méghna Singh / QA  "), "meghna-singh-qa");
})

test("keeps attempt id and source in a unique recording path", () => {
  assert.equal(
    buildCandidateRecordingFilePath({
      candidateName: "Mridul Sharma",
      attemptId: "a452bcfa-6660-42f3-b13e-628288862a6b",
      source: "browser",
      extension: ".webm",
      at: new Date("2026-07-21T04:55:35.096Z"),
    }),
    "recordings/mridul-sharma-a452bcfa-6660-42f3-b13e-628288862a6b-browser-2026-07-21T04-55-35-096Z.webm",
  );
});

test("uses a non-identifying fallback when the candidate name is missing", () => {
  assert.equal(sanitizeRecordingCandidateName(""), "candidate");
});
