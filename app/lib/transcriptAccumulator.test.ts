import assert from "node:assert/strict";
import test from "node:test";

import { mergeMonotonicTranscript } from "./transcriptAccumulator";
import { startRecognition } from "../services/verisVoice";

test("keeps the full answer when a restarted recognizer emits a shorter result", () => {
  assert.equal(
    mergeMonotonicTranscript(
      "I led the recruitment project across three regions",
      "and reduced the time to hire by twenty percent"
    ),
    "I led the recruitment project across three regions and reduced the time to hire by twenty percent"
  );
});

test("merges overlapping recognition sessions without duplicating words", () => {
  assert.equal(
    mergeMonotonicTranscript(
      "I reviewed the data and created a weekly report",
      "created a weekly report for the leadership team"
    ),
    "I reviewed the data and created a weekly report for the leadership team"
  );
});

test("does not replace a complete transcript with a shorter interim revision", () => {
  assert.equal(
    mergeMonotonicTranscript(
      "I reviewed the data and corrected the source records",
      "I reviewed the data"
    ),
    "I reviewed the data and corrected the source records"
  );
});

test("seeds a restarted SpeechRecognition instance with the prior transcript", () => {
  class FakeRecognition {
    static latest: FakeRecognition | null = null;
    continuous = false;
    interimResults = false;
    lang = "";
    onresult: ((event: {
      resultIndex: number;
      results: {
        length: number;
        [index: number]: { isFinal: boolean; 0: { transcript: string } };
      };
    }) => void) | null = null;
    onend: (() => void) | null = null;
    start() {
      FakeRecognition.latest = this;
    }
    stop() {}
  }

  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    SpeechRecognition: FakeRecognition,
  };

  try {
    let observed = "";
    startRecognition(
      (text) => {
        observed = text;
      },
      undefined,
      undefined,
      "I led the implementation across three regions"
    );

    FakeRecognition.latest?.onresult?.({
      resultIndex: 0,
      results: {
        0: {
          isFinal: false,
          0: { transcript: "and reduced processing time by twenty percent" },
        },
        length: 1,
      },
    });

    assert.equal(
      observed,
      "I led the implementation across three regions and reduced processing time by twenty percent"
    );
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
});
