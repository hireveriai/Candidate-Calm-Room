import assert from "node:assert/strict";
import test from "node:test";

import { documentPaths, getRetentionMode, recordingPaths } from "./dataRetention";
import { INTERVIEW_CONSENT_POINTS, MEDIA_RETENTION_DAYS, isCurrentConsentVersion, INTERVIEW_CONSENT_VERSION } from "./interviewConsent";
import { toStorageObjectPath } from "./recordingStorage";

test("retention is a dry run unless explicitly enforced", () => {
  assert.equal(getRetentionMode({}), "dry_run");
  assert.equal(getRetentionMode({ DATA_RETENTION_ENFORCE: "false" }), "dry_run");
  assert.equal(getRetentionMode({ DATA_RETENTION_ENFORCE: "yes" }), "dry_run");
  assert.equal(getRetentionMode({ DATA_RETENTION_ENFORCE: "true" }), "enforce");
  assert.equal(getRetentionMode({ DATA_RETENTION_ENFORCE: " TRUE " }), "enforce");
});

test("storage paths are extracted from bare paths and Supabase URLs only", () => {
  assert.equal(toStorageObjectPath("recordings/a/b.webm"), "recordings/a/b.webm");
  assert.equal(toStorageObjectPath("/recordings/a.webm"), "recordings/a.webm");
  assert.equal(
    toStorageObjectPath("https://x.supabase.co/storage/v1/object/public/recordings/att%201/file.webm"),
    "att 1/file.webm"
  );
  assert.equal(
    toStorageObjectPath("https://x.supabase.co/storage/v1/object/sign/recordings/a/b.mp4?token=abc"),
    "a/b.mp4"
  );
  // A URL on some other host is never turned into a deletable path.
  assert.equal(toStorageObjectPath("https://cdn.example.com/a.webm"), null);
  assert.equal(toStorageObjectPath("   "), null);
  assert.equal(toStorageObjectPath(null), null);
});

test("recording rows yield every distinct stored file", () => {
  const paths = recordingPaths([
    { recording_id: "1", file_path: "a/one.webm", audio_url: null, video_url: null },
    { recording_id: "2", file_path: null, audio_url: "https://x.supabase.co/storage/v1/object/public/rec/a/two.webm", video_url: "https://elsewhere.test/v.mp4" },
  ]);

  assert.deepEqual(paths, ["a/one.webm", "a/two.webm"]);
});

test("identity document paths come from the stored document list", () => {
  assert.deepEqual(documentPaths([{ type: "front", path: "cand/front.jpg" }, { type: "back", path: "" }, { type: "x" }]), ["cand/front.jpg"]);
  assert.deepEqual(documentPaths("not-a-list"), []);
});

test("consent text states the retention periods the job enforces", () => {
  assert.ok(isCurrentConsentVersion(INTERVIEW_CONSENT_VERSION));
  assert.ok(!isCurrentConsentVersion("2026-05"));
  assert.ok(INTERVIEW_CONSENT_POINTS.some((point) => point.includes(`${MEDIA_RETENTION_DAYS} days`)));
});
