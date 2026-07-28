import assert from "node:assert/strict";
import test from "node:test";

import { classifyAudioQualityWindow } from "./audioQualityPolicy";

test("detects sustained audible but unusually low microphone volume", () => {
  assert.deepEqual(
    classifyAudioQualityWindow({
      averageRms: 0.018,
      variability: 0.006,
      activeRatio: 0.55,
      activeSampleCount: 20,
    }),
    {
      lowMicrophoneVolume: true,
      backgroundNoiseDetected: false,
    },
  );
});

test("does not classify silence as low microphone volume", () => {
  assert.equal(
    classifyAudioQualityWindow({
      averageRms: 0.004,
      variability: 0.001,
      activeRatio: 0.05,
      activeSampleCount: 2,
    }).lowMicrophoneVolume,
    false,
  );
});

test("detects continuous steady background noise", () => {
  assert.deepEqual(
    classifyAudioQualityWindow({
      averageRms: 0.045,
      variability: 0.008,
      activeRatio: 0.95,
      activeSampleCount: 38,
    }),
    {
      lowMicrophoneVolume: false,
      backgroundNoiseDetected: true,
    },
  );
});

test("does not mistake variable speech for steady background noise", () => {
  assert.equal(
    classifyAudioQualityWindow({
      averageRms: 0.055,
      variability: 0.025,
      activeRatio: 0.9,
      activeSampleCount: 36,
    }).backgroundNoiseDetected,
    false,
  );
});
