import assert from "node:assert/strict";
import { buildRecordingEncodingProfile } from "../app/lib/livekit/egress.ts";

function estimatedMegabytes(profile, durationMinutes) {
  const totalKbps = profile.videoBitrate + profile.audioBitrate;
  return (totalKbps * 1000 * durationMinutes * 60) / 8 / 1024 / 1024;
}

for (const durationMinutes of [10, 30, 45, 60]) {
  const profile = buildRecordingEncodingProfile(durationMinutes);
  assert.ok(profile.videoBitrate >= 64);
  assert.ok(profile.audioBitrate >= 24);
  assert.ok(
    estimatedMegabytes(profile, durationMinutes) <= 42,
    `${durationMinutes}-minute recording exceeds target size`,
  );
}

console.log("Recording profile checks passed.");
