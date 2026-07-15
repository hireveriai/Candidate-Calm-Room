const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const path = require("node:path");
const dotenv = require("dotenv");
const { Client } = require("pg");

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config({ path: path.join(process.cwd(), ".env") });

const ffmpegPath = require("ffmpeg-static");
const APPLY = process.argv.includes("--apply");
const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
const attemptArgument = process.argv.find((argument) => argument.startsWith("--attempt="));
const LIMIT = Math.max(1, Math.min(500, Number(limitArgument?.split("=")[1] ?? 10)));
const ATTEMPT_ID = attemptArgument?.split("=")[1]?.trim() || null;
const SAMPLE_RATE = 16_000;
const WINDOW_SAMPLES = SAMPLE_RATE / 4;
const MIN_ACTIVE_RMS = 0.01;

function databaseConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const url = new URL(connectionString);
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  url.searchParams.delete("sslmode");
  return {
    connectionString: url.toString(),
    ssl: local ? false : { rejectUnauthorized: false },
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function standardDeviation(values, average) {
  if (values.length < 2) return 0;
  const variance = values.reduce((total, value) => total + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function encodeStoragePath(value) {
  return value.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function createSignedRecordingUrl(filePath) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const bucket = process.env.RECORDING_S3_BUCKET?.trim() || process.env.SUPABASE_STORAGE_BUCKET?.trim();
  if (!supabaseUrl || !serviceRoleKey || !bucket) {
    throw new Error("recording storage signing is not configured");
  }

  const endpoint = `${supabaseUrl}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodeStoragePath(filePath)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn: 3_600 }),
  });
  const payload = await response.json().catch(() => null);
  const signedPath = payload?.signedURL ?? payload?.signedUrl;
  if (!response.ok || !signedPath) throw new Error(payload?.message ?? payload?.error ?? "unable to sign recording URL");

  const relativePath = signedPath.startsWith("/object/") ? `/storage/v1${signedPath}` : signedPath;
  return relativePath.startsWith("http")
    ? relativePath
    : `${supabaseUrl}${relativePath.startsWith("/") ? "" : "/"}${relativePath}`;
}

async function analyzeRecording(recordingUrl) {
  const response = await fetch(recordingUrl);
  if (!response.ok || !response.body) {
    throw new Error(`recording download failed (${response.status})`);
  }

  const ffmpeg = spawn(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-vn",
    "-ac", "1",
    "-ar", String(SAMPLE_RATE),
    "-f", "f32le",
    "pipe:1",
  ], { windowsHide: true });

  const rmsWindows = [];
  let pending = Buffer.alloc(0);
  let stderr = "";

  ffmpeg.stdout.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const windowBytes = WINDOW_SAMPLES * 4;

    while (pending.length >= windowBytes) {
      const window = pending.subarray(0, windowBytes);
      pending = pending.subarray(windowBytes);
      let sumSquares = 0;

      for (let offset = 0; offset < window.length; offset += 4) {
        const sample = window.readFloatLE(offset);
        sumSquares += sample * sample;
      }

      const rms = Math.sqrt(sumSquares / WINDOW_SAMPLES);
      if (rms >= MIN_ACTIVE_RMS) rmsWindows.push(rms);
    }
  });
  ffmpeg.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
  });

  const recordingStream = Readable.fromWeb(response.body);
  recordingStream.on("error", () => {
    ffmpeg.stdin.destroy();
  });
  ffmpeg.stdin.on("error", (error) => {
    if (!["EPIPE", "EOF"].includes(error.code)) {
      stderr = `${stderr}${error.message}`.slice(-2_000);
    }
  });
  recordingStream.pipe(ffmpeg.stdin);

  const exitCode = await new Promise((resolve, reject) => {
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      recordingStream.destroy();
      resolve(code);
    });
  });

  if (exitCode !== 0) throw new Error(stderr.trim() || `FFmpeg exited with code ${exitCode}`);
  if (rmsWindows.length < 8) return null;

  const averageRms = rmsWindows.reduce((total, value) => total + value, 0) / rmsWindows.length;
  const variability = standardDeviation(rmsWindows, averageRms);
  const score = clamp((averageRms * 3 + variability * 5) * 100, 0, 100);

  return {
    score: Number((score / 100).toFixed(4)),
    averageRms: Number(averageRms.toFixed(5)),
    variability: Number(variability.toFixed(5)),
    sampleCount: rmsWindows.length,
    model: "acoustic-activity-v1",
    interpretation: "experimental_non_clinical",
    source: "recording_backfill",
  };
}

async function loadCandidates(client) {
  const values = [LIMIT];
  let attemptFilter = "";
  if (ATTEMPT_ID) {
    values.push(ATTEMPT_ID);
    attemptFilter = "and ir.attempt_id = $2::uuid";
  }

  const result = await client.query(`
    with eligible_attempts as (
      select distinct ir.attempt_id
      from public.interview_recordings ir
      where ir.status = 'completed'
        and nullif(trim(ir.video_url), '') is not null
        ${attemptFilter}
        and not exists (
          select 1
          from public.interview_signals existing
          where existing.attempt_id = ir.attempt_id
            and existing.type = 'vocal_pressure'
        )
      order by ir.attempt_id
      limit $1
    ), ranked as (
      select
        ir.attempt_id,
        ir.video_url,
        ir.file_path,
        row_number() over (
          partition by ir.attempt_id
          order by
            case when ir.file_path like '%-browser-%' then 0 else 1 end,
            coalesce(ir.ended_at, ir.created_at) - coalesce(ir.started_at, ir.created_at) desc,
            ir.created_at desc
        ) as preference
      from public.interview_recordings ir
      join eligible_attempts eligible on eligible.attempt_id = ir.attempt_id
      where ir.status = 'completed'
        and nullif(trim(ir.video_url), '') is not null
    )
    select attempt_id::text, video_url, file_path, preference
    from ranked
    order by attempt_id, preference
  `, values);

  const grouped = new Map();
  for (const row of result.rows) {
    const current = grouped.get(row.attempt_id) ?? { attempt_id: row.attempt_id, recordings: [] };
    current.recordings.push({ video_url: row.video_url, file_path: row.file_path });
    grouped.set(row.attempt_id, current);
  }

  return [...grouped.values()];
}

async function main() {
  if (!ffmpegPath) throw new Error("ffmpeg-static is unavailable on this platform");
  const client = new Client(databaseConfig());
  await client.connect();

  try {
    const candidates = await loadCandidates(client);
    console.log(`${APPLY ? "Applying" : "Dry run for"} ${candidates.length} historical recording(s).`);
    let analyzed = 0;
    let written = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      try {
        let result = null;
        let lastError = null;

        for (const recording of candidate.recordings) {
          try {
            const recordingUrl = recording.file_path
              ? await createSignedRecordingUrl(recording.file_path)
              : recording.video_url;
            result = await analyzeRecording(recordingUrl);
            if (result) break;
          } catch (error) {
            lastError = error;
          }
        }

        if (!result) {
          skipped += 1;
          const reason = lastError instanceof Error ? lastError.message : "insufficient active audio";
          console.log(`${candidate.attempt_id}: skipped (${reason})`);
          continue;
        }

        analyzed += 1;
        if (APPLY) {
          const inserted = await client.query(`
            insert into public.interview_signals (attempt_id, type, value)
            select $1::uuid, 'vocal_pressure', $2::jsonb
            where not exists (
              select 1 from public.interview_signals
              where attempt_id = $1::uuid and type = 'vocal_pressure'
            )
            returning signal_id
          `, [candidate.attempt_id, JSON.stringify(result)]);
          written += inserted.rowCount;
        }

        console.log(`${candidate.attempt_id}: ${Math.round(result.score * 100)}% (${result.sampleCount} samples)${APPLY ? " saved" : ""}`);
      } catch (error) {
        skipped += 1;
        console.warn(`${candidate.attempt_id}: skipped (${error instanceof Error ? error.message : "analysis failed"})`);
      }
    }

    console.log(JSON.stringify({ candidates: candidates.length, analyzed, written, skipped, dryRun: !APPLY }));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
