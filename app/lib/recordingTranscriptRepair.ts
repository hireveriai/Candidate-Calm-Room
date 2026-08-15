import OpenAI from "openai";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

import { prisma } from "@/app/lib/prisma";
import { isInvalidCandidateTranscript } from "@/app/lib/transcriptGuards";
import {
  hasUnverifiedIncompleteSpokenAnswer,
} from "@/app/lib/transcriptIntegrity";
import {
  findFirstUsableRecordingTranscript,
  isDegenerateRecordingTranscript,
  isReusableRecordingTranscript,
  prioritizeRecordingCandidates,
} from "@/app/lib/recordingRepairPolicy";
import {
  classifyInterviewQuestion,
  normalizeInterviewQuestionType,
} from "@/app/lib/interviewQuestionTypes";
import {
  deriveSkillType,
  evaluateAnswerWithAi,
} from "@/app/lib/answerEvaluation";

type RepairQuestionRow = {
  answer_id: string;
  session_question_id: string | null;
  answer_payload: unknown | null;
  question_order: number | null;
  question: string | null;
  answer_text: string | null;
  code_text: string | null;
  language: string | null;
  status: string | null;
  source_type?: string | null;
  skill_name?: string | null;
  job_title?: string | null;
  question_type?: string | null;
};

type RepairRecordingRow = {
  recording_id: string;
  file_path: string;
  transcript: string | null;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  object_size: bigint | number | string | null;
  duration_seconds: number | string | null;
};

type AlignedAnswer = {
  question_order?: number;
  answer?: string;
  evidence?: string;
  confidence?: number;
};

type RecordingTranscription = {
  text?: unknown;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: unknown;
  }>;
  duration?: number;
  usage?: {
    seconds?: number;
  };
};

type QuestionWindowRow = {
  answer_id: string;
  question_order: number;
  question: string;
  start_seconds: number | string;
  end_seconds: number | string;
};

type CompletionAuditRow = {
  session_question_id: string;
  question_id: string | null;
  question_order: number | null;
  question: string | null;
  answer_id: string | null;
  answer_text: string | null;
  answer_payload: unknown | null;
  status: string | null;
  code_text: string | null;
};

export type CompletionTranscriptIntegrityResult = {
  checkedAt: string;
  createdPlaceholders: number;
  rejectedQuestionEchoes: number;
  repairedAnswers: number;
  remainingIssues: number;
  status: "clean" | "repaired" | "needs_review";
  repairSkipped?: string;
};

// OpenAI transcription uploads must remain below 25 MB, but the original
// interview video can be much larger. Large videos are converted to a small,
// mono speech-only MP3 before upload instead of being silently excluded.
const MAX_TRANSCRIPTION_UPLOAD_BYTES = 24_000_000;
const MAX_REPAIR_OBJECT_BYTES = 150_000_000;
const MAX_REPAIR_AUDIO_SECONDS = 75 * 60;
const MAX_REPAIR_FAILURES = 5;
const TRANSCRIPTION_LEASE_MINUTES = 10;

/**
 * `incomplete` means the run made real progress and stopped on its own time
 * budget with work still to do. It is not a failure: it must not consume a
 * retry or trigger backoff, or a long interview would exhaust
 * MAX_REPAIR_FAILURES before it ever finished.
 */
type RepairLeaseOutcome = "completed" | "failed" | "partial" | "incomplete";

/**
 * How long one invocation may spend aligning and evaluating answers.
 *
 * The watchdog route caps at maxDuration = 300s and budgets 240s for its own
 * loop. A segmented recording costs one OpenAI alignment call per question
 * plus one evaluation call per recovered answer -- roughly twenty sequential
 * round-trips on a 30-minute interview, which overran the limit and got the
 * process killed mid-run. A killed process throws nothing, so the lease was
 * never released and the same interview re-stuck on every pass.
 *
 * Staying inside this budget and persisting what is done makes the repair
 * resumable: answers already recovered stop being pending, so each pass has
 * strictly less to do than the last.
 */
const REPAIR_TIME_BUDGET_MS = 150_000;

function normalizeText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isNoResponse(value: unknown) {
  return /^no response provided\.?$/i.test(normalizeText(value));
}

function isUnsafeAlignedAnswer(value: unknown) {
  const answer = normalizeText(value);

  // A normal spoken response cannot safely be inferred when alignment returns
  // a huge portion of the interview. Long or repetitive output is usually a
  // Whisper silence hallucination or a failed whole-transcript alignment.
  return answer.length > 8_000 || isDegenerateRecordingTranscript(answer);
}

function wordCount(value: unknown) {
  return normalizeText(value).split(/\s+/).filter(Boolean).length;
}

function isRecoveredAnswerMateriallyBetter(existingValue: unknown, recoveredValue: unknown) {
  const existing = normalizeText(existingValue);
  const recovered = normalizeText(recoveredValue);
  if (!recovered || isNoResponse(recovered) || isUnsafeAlignedAnswer(recovered)) {
    return false;
  }
  if (!existing || isNoResponse(existing)) {
    return true;
  }
  if (
    isDegenerateRecordingTranscript(existing) &&
    !isDegenerateRecordingTranscript(recovered)
  ) {
    return true;
  }

  const existingTokens = existing.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const recoveredTokens = recovered.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  if (recoveredTokens.length < existingTokens.length + 8) {
    return false;
  }

  const recoveredSet = new Set(recoveredTokens);
  const coveredExistingTokens = existingTokens.filter((token) => recoveredSet.has(token)).length;
  const coverage = existingTokens.length > 0 ? coveredExistingTokens / existingTokens.length : 0;

  // Require strong overlap so a whole-interview alignment mistake cannot
  // replace a valid answer belonging to another question.
  return coverage >= 0.58 && recoveredTokens.length >= Math.ceil(existingTokens.length * 1.18);
}

function getRecordingBucket() {
  return (
    process.env.RECORDING_S3_BUCKET?.trim() ||
    process.env.SUPABASE_STORAGE_BUCKET?.trim() ||
    "recordings"
  );
}

function getSupabaseConfig() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return { supabaseUrl, serviceRoleKey };
}

async function fetchObjectBuffer(filePath: string) {
  const config = getSupabaseConfig();
  if (!config) {
    throw new Error("Supabase service credentials are not configured");
  }

  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const url = `${config.supabaseUrl}/storage/v1/object/${encodeURIComponent(getRecordingBucket())}/${encodedPath}`;
  const response = await fetch(url, {
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch recording object: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function fetchRepairQuestions(attemptId: string) {
  const rows = await prisma.$queryRaw<RepairQuestionRow[]>`
    select
      ans.answer_id::text,
      ans.session_question_id::text,
      ans.answer_payload,
      ans.answer_text,
      cs.code_text,
      cs.language,
      ans.status,
      coalesce(sq.question_order, iq.question_order) as question_order,
      coalesce(sq.content, iq.question_text, q.question_text) as question,
      iq.source_type,
      sm.skill_name,
      jp.job_title,
      coalesce(iq.question_type, sq.question_kind) as question_type
    from public.interview_answers ans
    left join public.session_questions sq
      on sq.session_question_id = ans.session_question_id
      or (sq.attempt_id = ans.attempt_id and sq.question_id = ans.question_id)
    left join public.interview_attempts att on att.attempt_id = ans.attempt_id
    left join public.interviews i on i.interview_id = att.interview_id
    left join public.job_positions jp on jp.job_id = i.job_id
    left join public.interview_questions iq
      on iq.interview_id = att.interview_id
      and (
        iq.interview_question_id = ans.question_id
        or iq.question_id = ans.question_id
        or iq.interview_question_id = ans.session_question_id
        or iq.question_id = sq.question_id
      )
    left join public.questions q
      on q.question_id = coalesce(ans.question_id, sq.question_id, iq.question_id)
    left join public.question_skill_map qsm
      on qsm.question_id = ans.question_id
    left join public.skill_master sm
      on sm.skill_id = coalesce(iq.target_skill_id, qsm.skill_id)
    left join public.interview_code_submissions cs
      on cs.answer_id = ans.answer_id
    where ans.attempt_id = ${attemptId}::uuid
    order by coalesce(sq.question_order, iq.question_order) asc nulls last, ans.answered_at asc nulls last
  `;

  return rows.map((row: RepairQuestionRow, index: number) => ({
    ...row,
    question_order: Number(row.question_order ?? index + 1),
    question: normalizeText(row.question),
  }));
}

async function fetchRepairRecordings(attemptId: string): Promise<RepairRecordingRow[]> {
  const rows = await prisma.$queryRaw<RepairRecordingRow[]>`
    select
      ir.recording_id::text,
      ir.file_path,
      ir.transcript,
      ir.started_at,
      ir.ended_at,
      greatest(
        extract(epoch from (coalesce(ir.ended_at, ir.created_at) - coalesce(ir.started_at, ir.created_at))),
        0
      ) as duration_seconds,
      coalesce((so.metadata->>'size')::bigint, 0) as object_size
    from public.interview_recordings ir
    left join storage.objects so
      on so.bucket_id = ${getRecordingBucket()}
     and so.name = ir.file_path
    where ir.attempt_id = ${attemptId}::uuid
      and ir.status = 'completed'
      and ir.file_path is not null
      and (
        coalesce((so.metadata->>'size')::bigint, 0) > 0
        or nullif(btrim(coalesce(ir.transcript, '')), '') is not null
      )
      and coalesce((so.metadata->>'size')::bigint, 0) <= ${MAX_REPAIR_OBJECT_BYTES}
    order by coalesce(ir.started_at, ir.created_at), ir.recording_id
  `;

  return prioritizeRecordingCandidates<RepairRecordingRow>(rows);
}

async function claimRepairLease(attemptId: string, recordingId: string) {
  const token = randomUUID();
  const rows = await prisma.$queryRaw<Array<{ attempt_id: string }>>`
    update public.interview_attempts
    set termination_metadata = jsonb_set(
      coalesce(termination_metadata, '{}'::jsonb),
      '{transcription_repair}',
      coalesce(termination_metadata->'transcription_repair', '{}'::jsonb) || jsonb_build_object(
        'lease_token', ${token}::text,
        'recording_id', ${recordingId}::text,
        'status', 'processing',
        'started_at', now(),
        'locked_until', now() + (${TRANSCRIPTION_LEASE_MINUTES} * interval '1 minute')
      ),
      true
    )
    where attempt_id = ${attemptId}::uuid
      and coalesce(
        nullif(termination_metadata #>> '{transcription_repair,locked_until}', '')::timestamptz,
        'epoch'::timestamptz
      ) <= now()
      and coalesce(
        nullif(termination_metadata #>> '{transcription_repair,next_retry_at}', '')::timestamptz,
        'epoch'::timestamptz
      ) <= now()
      and coalesce(
        case
          when coalesce(termination_metadata #>> '{transcription_repair,failure_count}', '') ~ '^[0-9]+$'
            then (termination_metadata #>> '{transcription_repair,failure_count}')::int
          else 0
        end,
        0
      ) < ${MAX_REPAIR_FAILURES}
    returning attempt_id::text
  `;

  return rows.length > 0 ? token : null;
}

async function releaseRepairLease(params: {
  attemptId: string;
  token: string;
  recordingId: string;
  outcome: RepairLeaseOutcome;
  rawTranscriptPersisted: boolean;
  billedAudioSeconds?: number | null;
  error?: unknown;
}) {
  // `incomplete` is progress, not a fault: it leaves failure_count and the
  // retry backoff untouched so the next pass can carry straight on.
  const failed = params.outcome !== "completed" && params.outcome !== "incomplete";
  const errorMessage = params.error instanceof Error
    ? params.error.message.slice(0, 500)
    : params.error
      ? String(params.error).slice(0, 500)
      : null;

  await prisma.$executeRaw`
    update public.interview_attempts
    set termination_metadata = jsonb_set(
      coalesce(termination_metadata, '{}'::jsonb),
      '{transcription_repair}',
      coalesce(termination_metadata->'transcription_repair', '{}'::jsonb) || jsonb_build_object(
        'lease_token', null,
        'recording_id', ${params.recordingId}::text,
        'status', ${params.outcome}::text,
        'finished_at', now(),
        'locked_until', now(),
        'raw_transcript_persisted', ${params.rawTranscriptPersisted}::boolean,
        'billed_audio_seconds', ${params.billedAudioSeconds ?? null}::numeric,
        'last_error', ${errorMessage}::text,
        'failure_count', case
          when ${failed}::boolean then coalesce(
            case
              when coalesce(termination_metadata #>> '{transcription_repair,failure_count}', '') ~ '^[0-9]+$'
                then (termination_metadata #>> '{transcription_repair,failure_count}')::int
              else 0
            end,
            0
          ) + 1
          else 0
        end,
        'next_retry_at', case
          when ${failed}::boolean then now() + (
            least(
              360,
              15 * power(
                2,
                least(
                  case
                    when coalesce(termination_metadata #>> '{transcription_repair,failure_count}', '') ~ '^[0-9]+$'
                      then (termination_metadata #>> '{transcription_repair,failure_count}')::int
                    else 0
                  end,
                  4
                )
              )
            )::text || ' minutes'
          )::interval
          else null
        end
      ),
      true
    )
    where attempt_id = ${params.attemptId}::uuid
      and termination_metadata #>> '{transcription_repair,lease_token}' = ${params.token}
  `;
}

async function resolveFfmpegExecutable() {
  const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = [
    process.env.FFMPEG_PATH?.trim(),
    join(process.cwd(), "node_modules", "ffmpeg-static", binaryName),
    ffmpegPath,
    process.platform === "win32" ? null : "/usr/bin/ffmpeg",
    process.platform === "win32" ? null : "/usr/local/bin/ffmpeg",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Check the next packaged or system path.
    }
  }

  throw new Error(
    "FFmpeg binary is unavailable at runtime; recording transcription remains queued"
  );
}

async function runFfmpeg(args: string[]) {
  const executable = await resolveFfmpegExecutable();

  await new Promise<void>((resolve, reject) => {
    const process = spawn(executable, args, { windowsHide: true });
    let stderr = "";
    process.stdout.resume();
    process.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2_000);
    });
    process.once("error", reject);
    process.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg audio extraction failed (${code}): ${stderr}`));
    });
  });
}

async function transcribeRecording(openai: OpenAI, filePath: string) {
  const buffer = await fetchObjectBuffer(filePath);
  let uploadBuffer = buffer;
  let uploadName = `recording${extname(filePath).split("?")[0] || ".webm"}`;
  const lowerPath = filePath.toLowerCase();
  let uploadType = lowerPath.includes(".m4a")
    ? "audio/mp4"
    : lowerPath.includes(".mp3")
      ? "audio/mpeg"
      : lowerPath.includes(".ogg")
        ? "audio/ogg"
        : lowerPath.includes(".mp4")
          ? "video/mp4"
          : lowerPath.includes(".webm")
            ? "audio/webm"
            : "application/octet-stream";

  if (buffer.byteLength > MAX_TRANSCRIPTION_UPLOAD_BYTES) {
    const token = randomUUID();
    const sourceExtension = extname(filePath).split("?")[0] || ".webm";
    const inputPath = join(tmpdir(), `hireveri-transcript-${token}${sourceExtension}`);
    const outputPath = join(tmpdir(), `hireveri-transcript-${token}.mp3`);

    try {
      await fs.writeFile(inputPath, buffer);
      await runFfmpeg([
        "-y",
        "-i", inputPath,
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-b:a", "32k",
        outputPath,
      ]);
      uploadBuffer = await fs.readFile(outputPath);
      uploadName = "recording-audio.mp3";
      uploadType = "audio/mpeg";
    } finally {
      await Promise.allSettled([fs.unlink(inputPath), fs.unlink(outputPath)]);
    }
  }

  if (uploadBuffer.byteLength > MAX_TRANSCRIPTION_UPLOAD_BYTES) {
    throw new Error("Compressed recording still exceeds the transcription upload limit");
  }

  const file = new File([uploadBuffer], uploadName, { type: uploadType });

  return openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    language: "en",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
    temperature: 0,
  });
}

function needsRecordingRepair(question: RepairQuestionRow) {
  const answer = normalizeText(question.answer_text);
  return (
    !answer ||
    isNoResponse(answer) ||
    question.status === "generating" ||
    question.status === "failed" ||
    isDegenerateRecordingTranscript(answer) ||
    hasUnverifiedIncompleteSpokenAnswer(question)
  );
}

async function fetchQuestionWindows(
  attemptId: string,
  recordingId: string
): Promise<QuestionWindowRow[]> {
  return prisma.$queryRaw<QuestionWindowRow[]>`
    with ordered_questions as (
      select
        sq.session_question_id,
        sq.question_order,
        sq.content as question,
        sq.asked_at,
        lead(sq.asked_at) over (
          order by sq.question_order asc, sq.asked_at asc
        ) as next_asked_at
      from public.session_questions sq
      where sq.attempt_id = ${attemptId}::uuid
    )
    select
      ans.answer_id::text,
      oq.question_order,
      oq.question,
      greatest(
        extract(epoch from (oq.asked_at - ir.started_at)),
        0
      ) as start_seconds,
      greatest(
        extract(epoch from (
          least(
            coalesce(oq.next_asked_at, ia.ended_at, ir.ended_at),
            coalesce(ir.ended_at, ia.ended_at, now())
          ) - ir.started_at
        )),
        0
      ) as end_seconds
    from ordered_questions oq
    join public.interview_answers ans
      on ans.session_question_id = oq.session_question_id
    join public.interview_attempts ia
      on ia.attempt_id = ans.attempt_id
    join public.interview_recordings ir
      on ir.recording_id = ${recordingId}::uuid
    order by oq.question_order
  `;
}

async function transcribeQuestionWindow(
  openai: OpenAI,
  sourcePath: string,
  startSeconds: number,
  endSeconds: number,
  question: RepairQuestionRow
) {
  const outputPath = join(
    tmpdir(),
    `hireveri-question-window-${randomUUID()}.mp3`
  );

  try {
    await runFfmpeg([
      "-y",
      "-ss", String(Math.max(0, startSeconds)),
      "-t", String(Math.max(1, endSeconds - startSeconds)),
      "-i", sourcePath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "32k",
      outputPath,
    ]);
    const audio = await fs.readFile(outputPath);
    const result = await openai.audio.transcriptions.create({
      file: new File([audio], "question-window.mp3", { type: "audio/mpeg" }),
      model:
        process.env.OPENAI_RECORDING_WINDOW_TRANSCRIPTION_MODEL ||
        "gpt-4o-transcribe-diarize",
      language: "en",
      response_format: "diarized_json",
      chunking_strategy: "auto",
    });
    const transcript = normalizeText(result.text);
    if (!transcript || isDegenerateRecordingTranscript(transcript)) {
      return null;
    }

    const aligned = await alignAnswers(openai, [question], transcript);
    const answer = normalizeText(aligned[0]?.answer);
    return answer &&
      !isNoResponse(answer) &&
      !isUnsafeAlignedAnswer(answer) &&
      !isInvalidCandidateTranscript({
        transcript: answer,
        questionText: question.question,
      })
      ? answer
      : null;
  } finally {
    await fs.unlink(outputPath).catch(() => undefined);
  }
}

async function recoverAnswersFromQuestionWindows(params: {
  openai: OpenAI;
  attemptId: string;
  recording: RepairRecordingRow;
  questions: RepairQuestionRow[];
  answersByOrder: Map<number, string>;
}) {
  const targets = params.questions.filter((question) => {
    if (!needsRecordingRepair(question)) return false;
    const aligned = params.answersByOrder.get(Number(question.question_order));
    return (
      !aligned ||
      isNoResponse(aligned) ||
      isUnsafeAlignedAnswer(aligned) ||
      isInvalidCandidateTranscript({
        transcript: aligned,
        questionText: question.question,
      })
    );
  });
  if (targets.length === 0) return;

  const windows = await fetchQuestionWindows(
    params.attemptId,
    params.recording.recording_id
  );
  const windowsByOrder = new Map<number, QuestionWindowRow>(
    windows.map((window: QuestionWindowRow) => [
      Number(window.question_order),
      window,
    ])
  );
  const sourceBuffer = await fetchObjectBuffer(params.recording.file_path);
  const sourceExtension =
    extname(params.recording.file_path).split("?")[0] || ".webm";
  const sourcePath = join(
    tmpdir(),
    `hireveri-window-source-${randomUUID()}${sourceExtension}`
  );
  await fs.writeFile(sourcePath, sourceBuffer);

  try {
    for (let index = 0; index < targets.length; index += 3) {
      const batch = targets.slice(index, index + 3);
      await Promise.all(
        batch.map(async (question) => {
          const window = windowsByOrder.get(Number(question.question_order));
          if (!window) return;
          const answer = await transcribeQuestionWindow(
            params.openai,
            sourcePath,
            Number(window.start_seconds),
            Number(window.end_seconds),
            question
          );
          if (answer) {
            params.answersByOrder.set(Number(question.question_order), answer);
          }
        })
      );
    }
  } finally {
    await fs.unlink(sourcePath).catch(() => undefined);
  }
}

type SegmentQuestionWindow = {
  question_order: number;
  question: string;
  asked_at: Date;
  window_end: Date;
};

// Browser-fallback recordings are many short files, not one continuous
// stream, so the question-order timestamp only tells us where a question
// falls in wall-clock time, not which byte offset of which file. This
// resolves that against the per-segment elapsed timeline built while the
// segments were aggregated above.
async function fetchSegmentQuestionWindows(attemptId: string) {
  return prisma.$queryRaw<SegmentQuestionWindow[]>`
    with ordered_questions as (
      select
        sq.question_order,
        sq.content as question,
        sq.asked_at,
        lead(sq.asked_at) over (
          order by sq.question_order asc, sq.asked_at asc
        ) as next_asked_at
      from public.session_questions sq
      where sq.attempt_id = ${attemptId}::uuid
    )
    select
      oq.question_order,
      oq.question,
      oq.asked_at,
      coalesce(oq.next_asked_at, ia.ended_at, now()) as window_end
    from ordered_questions oq
    join public.interview_attempts ia on ia.attempt_id = ${attemptId}::uuid
    order by oq.question_order
  `;
}

// A single batched alignment call across the whole interview pressures the
// model to compress every answer to fit one JSON response, which silently
// drops most of what the candidate said. Instead, resolve each question to
// only the recording segments whose wall-clock span overlaps that question's
// window, so alignment runs per-question against a small, focused excerpt.
function buildSegmentWindowTranscripts(params: {
  referenceStart: Date;
  timeline: Array<{
    recordingId: string;
    startSeconds: number;
    endSeconds: number;
    text: string;
  }>;
  questionWindows: SegmentQuestionWindow[];
}) {
  const referenceMs = params.referenceStart.getTime();
  const result = new Map<number, string>();

  for (const window of params.questionWindows) {
    const startSeconds = (new Date(window.asked_at).getTime() - referenceMs) / 1000;
    const endSeconds = (new Date(window.window_end).getTime() - referenceMs) / 1000;

    const overlapping = params.timeline
      .filter(
        (segment) =>
          segment.endSeconds > startSeconds && segment.startSeconds < endSeconds
      )
      .sort((left, right) => left.startSeconds - right.startSeconds);

    if (overlapping.length > 0) {
      result.set(
        window.question_order,
        overlapping.map((segment) => segment.text).join("\n\n")
      );
      continue;
    }

    // Very short questions can fall entirely inside one segment without a
    // strict overlap match; fall back to the closest segment by midpoint so
    // short answers are not silently skipped.
    const midpoint = (startSeconds + endSeconds) / 2;
    let closest: (typeof params.timeline)[number] | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const segment of params.timeline) {
      const segmentMidpoint = (segment.startSeconds + segment.endSeconds) / 2;
      const distance = Math.abs(segmentMidpoint - midpoint);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = segment;
      }
    }
    if (closest) {
      result.set(window.question_order, closest.text);
    }
  }

  return result;
}

async function alignAnswers(openai: OpenAI, questions: RepairQuestionRow[], transcript: string) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You align an interview recording transcript to the exact ordered questions.",
          "Return only JSON: {\"answers\":[{\"question_order\":number,\"answer\":string,\"evidence\":string,\"confidence\":number}]}",
          "Use only words and meaning supported by the transcript.",
          "Exclude interviewer questions from candidate answers.",
          "Return only the candidate's direct response to that one question; never copy later questions or answers into it.",
          "The \"answer\" field must be the candidate's FULL response reproduced verbatim (word-for-word) from the transcript.",
          "Do not summarize, paraphrase, condense, or shorten the candidate's answer. Include every sentence the candidate spoke that is part of this answer, even if it is long or repetitive.",
          "If the transcript is repetitive, corrupted, or does not contain a clearly attributable answer, use exactly \"No response provided.\"",
          "If the candidate did not substantively answer a question, use exactly \"No response provided.\"",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          questions: questions.map((question) => ({
            question_order: question.question_order,
            question: question.question,
          })),
          transcript: normalizeText(transcript).slice(0, 60000),
        }),
      },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content) as { answers?: AlignedAnswer[] };
  return Array.isArray(parsed.answers) ? parsed.answers : [];
}

function mergePayload(payload: unknown, repairFields: Record<string, unknown>) {
  const base =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  return JSON.stringify({
    ...base,
    ...repairFields,
  });
}

async function loadCompletionAuditRows(attemptId: string): Promise<CompletionAuditRow[]> {
  return prisma.$queryRaw<CompletionAuditRow[]>`
    select
      sq.session_question_id::text,
      sq.question_id::text,
      sq.question_order,
      sq.content as question,
      ans.answer_id::text,
      ans.answer_text,
      ans.answer_payload,
      ans.status,
      cs.code_text
    from public.session_questions sq
    left join public.interview_answers ans
      on ans.session_question_id = sq.session_question_id
    left join public.interview_code_submissions cs
      on cs.answer_id = ans.answer_id
    where sq.attempt_id = ${attemptId}::uuid
    order by sq.question_order asc nulls last, sq.asked_at asc nulls last
  `;
}

function hasAnswerIssue(row: CompletionAuditRow) {
  if (row.code_text && normalizeText(row.code_text)) {
    return false;
  }

  if (!row.answer_id) {
    return true;
  }

  const answer = normalizeText(row.answer_text);
  return (
    !answer ||
    isNoResponse(answer) ||
    row.status === "generating" ||
    row.status === "failed" ||
    isDegenerateRecordingTranscript(answer) ||
    hasUnverifiedIncompleteSpokenAnswer(row) ||
    isInvalidCandidateTranscript({
      transcript: answer,
      questionText: row.question,
    })
  );
}

async function countRemainingCompletionIssues(attemptId: string) {
  const rows = await loadCompletionAuditRows(attemptId);
  return rows.filter(hasAnswerIssue).length;
}

async function createMissingAnswerPlaceholders(attemptId: string) {
  const rows = await prisma.$queryRaw<Array<{ count: bigint | number | string }>>`
    with inserted as (
      insert into public.interview_answers (
        attempt_id,
        question_id,
        session_question_id,
        answer_text,
        answer_payload,
        status
      )
      select
        sq.attempt_id,
        null::uuid,
        sq.session_question_id,
        null::text,
        jsonb_build_object(
          'answer_mode', 'spoken',
          'live_transcript_missing', true,
          'transcription_pending', true,
          'pending_reason', 'completion_integrity_missing_answer_row',
          'pending_at', now()
        ),
        'generating'
      from public.session_questions sq
      left join public.interview_answers ans
        on ans.session_question_id = sq.session_question_id
      where sq.attempt_id = ${attemptId}::uuid
        and ans.answer_id is null
      on conflict (session_question_id) where session_question_id is not null
      do nothing
      returning 1
    )
    select count(*) as count from inserted
  `;

  return Number(rows[0]?.count ?? 0);
}

async function rejectQuestionEchoAnswers(attemptId: string) {
  const rows = await loadCompletionAuditRows(attemptId);
  const invalidRows = rows.filter(
    (row: CompletionAuditRow) =>
      row.answer_id &&
      !row.code_text &&
      normalizeText(row.answer_text) &&
      isInvalidCandidateTranscript({
        transcript: row.answer_text,
        questionText: row.question,
      })
  );

  for (const row of invalidRows) {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`
        update public.interview_answers
        set answer_text = null,
            status = 'generating',
            answer_payload = coalesce(answer_payload, '{}'::jsonb) || ${JSON.stringify({
              rejected_transcript: row.answer_text,
              transcript_rejected_reason: "completion_integrity_question_echo",
              completion_integrity_rejected_at: new Date().toISOString(),
              transcription_pending: true,
              live_transcript_missing: true,
            })}::jsonb
        where answer_id = ${row.answer_id}::uuid
      `;

      await tx.$executeRaw`
        delete from public.interview_answer_evaluations
        where answer_id = ${row.answer_id}::uuid
          and evaluator_type = 'AI'
      `;
    });
  }

  return invalidRows.length;
}

// Last-resort scoring when real AI evaluation is unavailable (no API key, or
// the call failed). The recruiter-facing "feedback" text here must read like
// genuine feedback on the answer's content, never a description of how the
// transcript was obtained — that internal detail belongs in evaluation_json,
// not in a field the recruiter dashboard renders as "VERIS Feedback".
function buildHeuristicRecoveredEvaluation(answer: string) {
  const words = normalizeText(answer).split(/\s+/).filter(Boolean).length;
  const hasSpecificity = /\b\d+(\.\d+)?%?\b|team|customer|process|project|metric|budget|sla|crm|sap|report|compliance|risk/i.test(answer);
  const clarity = words >= 60 ? 0.72 : words >= 35 ? 0.64 : words >= 18 ? 0.52 : 0.38;
  const depth = hasSpecificity ? Math.max(0.58, clarity - 0.03) : Math.max(0.38, clarity - 0.12);
  const confidence = words >= 35 ? 0.66 : words >= 18 ? 0.54 : 0.4;
  const skill = Math.max(0.35, Math.min(0.78, skillWeightedScore(clarity, depth, confidence)));

  return {
    score: Math.round(skill * 100),
    skill_score: skill,
    clarity_score: clarity,
    depth_score: depth,
    confidence_score: confidence,
    fraud_score: 0.08,
    feedback:
      "Automated scoring estimate based on the candidate's recorded answer. Detailed AI feedback was unavailable for this response.",
    evaluation_json: {
      mode: "recording_auto_repair_heuristic",
      word_count: words,
      has_specificity: hasSpecificity,
    },
  };
}

// Recovered answers must be judged on their actual content by the same AI
// evaluator used for normally captured answers, not a word-count heuristic
// with a placeholder message describing the recovery mechanism.
async function evaluateRecoveredAnswer(question: RepairQuestionRow, answer: string) {
  try {
    const resolvedQuestionType = normalizeInterviewQuestionType(
      question.question_type,
      classifyInterviewQuestion(
        question.question ?? "",
        question.job_title ?? undefined,
        question.skill_name ? [question.skill_name] : []
      ).questionType
    );
    const skillType = deriveSkillType(
      question.source_type,
      question.skill_name,
      resolvedQuestionType
    );

    const aiEvaluation = await evaluateAnswerWithAi({
      jobRole: question.job_title ?? null,
      skillName: question.skill_name ?? null,
      skillType,
      questionText: question.question,
      transcript: answer,
      rawTranscript: null,
      focusMetrics: null,
      behaviorSignals: [],
      questionType: resolvedQuestionType,
    });

    if (aiEvaluation) {
      return {
        score: Math.round(aiEvaluation.skill_score * 100),
        skill_score: aiEvaluation.skill_score,
        clarity_score: aiEvaluation.clarity_score,
        depth_score: aiEvaluation.depth_score,
        confidence_score: aiEvaluation.confidence_score,
        fraud_score: aiEvaluation.fraud_score,
        feedback: aiEvaluation.reasoning,
        evaluation_json: {
          ...(typeof aiEvaluation.evaluation_json === "object" &&
          aiEvaluation.evaluation_json &&
          !Array.isArray(aiEvaluation.evaluation_json)
            ? aiEvaluation.evaluation_json
            : {}),
          mode: "recording_auto_repair_ai",
        },
      };
    }
  } catch (error) {
    console.error("Recovered-answer AI evaluation failed, using heuristic fallback", {
      answerId: question.answer_id,
      error,
    });
  }

  return buildHeuristicRecoveredEvaluation(answer);
}

function skillWeightedScore(clarity: number, depth: number, confidence: number) {
  return clarity * 0.35 + depth * 0.45 + confidence * 0.2;
}

/**
 * Releases a lease this process is still holding after an unexpected throw.
 *
 * The lease is only released at the explicit success and failure exits, so any
 * error raised between claiming it and reaching one of those left the attempt
 * pinned as `processing` until `locked_until` expired. Completion runs once, so
 * an attempt whose repair crashed mid-run was never retried -- it simply
 * finished as PARTIAL with the recoverable answers still missing.
 */
async function releaseCrashedRepairLease(attemptId: string, token: string, error: unknown) {
  try {
    await releaseRepairLease({
      attemptId,
      token,
      recordingId: "",
      outcome: "failed",
      rawTranscriptPersisted: false,
      error,
    });
  } catch (releaseError) {
    console.error("Unable to release a crashed transcript repair lease", {
      attemptId,
      error: releaseError,
    });
  }
}

export async function repairPendingAnswersFromRecording(
  attemptId: string,
  options?: { force?: boolean }
) {
  let activeLeaseToken: string | null = null;

  try {
    return await runRepairPendingAnswersFromRecording(attemptId, options, (token) => {
      activeLeaseToken = token;
    });
  } catch (error) {
    if (activeLeaseToken) {
      await releaseCrashedRepairLease(attemptId, activeLeaseToken, error);
    }
    throw error;
  }
}

async function runRepairPendingAnswersFromRecording(
  attemptId: string,
  options: { force?: boolean } | undefined,
  onLeaseClaimed: (token: string) => void
) {
  const codeRepair = await repairCodingAnswersFromSubmissions(attemptId);

  const spokenRows = await prisma.$queryRaw<RepairQuestionRow[]>`
    select
      ans.answer_id::text,
      ans.answer_payload,
      ans.answer_text,
      cs.code_text,
      cs.language,
      sq.question_order,
      sq.content as question
    from public.interview_answers ans
    left join public.interview_code_submissions cs
      on cs.answer_id = ans.answer_id
    left join public.session_questions sq
      on sq.session_question_id = ans.session_question_id
    where ans.attempt_id = ${attemptId}::uuid
      and cs.answer_id is null
  `;
  const hasAnswerNeedingRecordingCheck =
    options?.force || spokenRows.some(needsRecordingRepair);

  if (!hasAnswerNeedingRecordingCheck) {
    return codeRepair.repaired > 0
      ? { repaired: codeRepair.repaired, skipped: "no_spoken_pending_answers" }
      : { repaired: 0, skipped: "no_incomplete_answers_detected" };
  }

  if (!process.env.OPENAI_API_KEY || !getSupabaseConfig()) {
    return codeRepair.repaired > 0
      ? { repaired: codeRepair.repaired, skipped: "missing_spoken_repair_configuration" }
      : { repaired: 0, skipped: "missing_configuration" };
  }

  const recordings = await fetchRepairRecordings(attemptId);
  if (recordings.length === 0) {
    return { repaired: 0, skipped: "no_usable_recording" };
  }

  const eligibleRecordings = recordings.filter(
    (recording) =>
      normalizeText(recording.transcript) ||
      Number(recording.duration_seconds ?? 0) <= MAX_REPAIR_AUDIO_SECONDS
  );
  if (eligibleRecordings.length === 0) {
    return { repaired: codeRepair.repaired, skipped: "recording_exceeds_transcription_cost_limit" };
  }

  const leaseRecording = eligibleRecordings[0];
  const leaseToken = await claimRepairLease(
    attemptId,
    leaseRecording.recording_id
  );
  if (!leaseToken) {
    return { repaired: codeRepair.repaired, skipped: "repair_already_running_or_backing_off" };
  }

  onLeaseClaimed(leaseToken);

  // Every phase below is bounded by one shared deadline, because each of them
  // can outlast the route on a long interview: transcribing N segments, then
  // one alignment call per question, then one evaluation per recovered answer.
  const repairDeadline = Date.now() + REPAIR_TIME_BUDGET_MS;
  const outOfTime = () => Date.now() >= repairDeadline;
  let budgetReached = false;
  // Set when segment transcription stops early. The aggregated transcript is
  // then only part of the interview, and aligning questions against it would
  // attribute answers to the wrong time windows, so alignment waits.
  let aggregationIncomplete = false;

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 120_000,
    maxRetries: 1,
  });
  const questions = await fetchRepairQuestions(attemptId);
  let selectedTranscript = await findFirstUsableRecordingTranscript(
    eligibleRecordings,
    async (recording): Promise<RecordingTranscription> => {
      const existingRecordingTranscript = normalizeText(recording.transcript);
      if (isReusableRecordingTranscript(existingRecordingTranscript)) {
        return {
          text: existingRecordingTranscript,
          segments: [],
          duration: 0,
        };
      }

      return (await transcribeRecording(
        openai,
        recording.file_path
      )) as RecordingTranscription;
    }
  );

  // Browser fallback audio is uploaded in bounded segments so mobile Safari
  // and Chrome do not need to retain an entire interview in memory. Consume
  // every usable segment as one ordered transcript during completion repair.
  const browserSegments = eligibleRecordings
    .filter((recording) => recording.file_path.toLowerCase().includes("-browser-"))
    .sort(
      (left, right) =>
        new Date(left.started_at ?? 0).getTime() -
        new Date(right.started_at ?? 0).getTime()
    );
  let aggregateBilledAudioSeconds: number | null = null;
  let usedAggregatedBrowserSegments = false;

  const browserSegmentTimeline: Array<{
    recordingId: string;
    startSeconds: number;
    endSeconds: number;
    text: string;
  }> = [];

  if (browserSegments.length > 1) {
    const aggregateTexts: string[] = [];
    const aggregateSegments: NonNullable<RecordingTranscription["segments"]> = [];
    const aggregateFailures = [...selectedTranscript.failures];
    let elapsedSeconds = 0;
    let billedSeconds = 0;

    for (const recording of browserSegments) {
      // Each un-transcribed segment is a Whisper upload. Stopping here is
      // cheap to resume: every segment transcript is persisted below as soon
      // as it is produced, so the next pass reuses it instead of paying twice.
      if (outOfTime()) {
        budgetReached = true;
        aggregationIncomplete = true;
        console.warn("Repair time budget reached during segment transcription", {
          attemptId,
          transcribedThisPass: aggregateTexts.length,
          totalSegments: browserSegments.length,
        });
        break;
      }

      try {
        const persistedTranscript = normalizeText(recording.transcript);
        const reused = Boolean(
          persistedTranscript && !isDegenerateRecordingTranscript(persistedTranscript)
        );
        const alreadyLoadedTranscription =
          selectedTranscript.recording?.recording_id === recording.recording_id
            ? selectedTranscript.transcription
            : null;
        const transcription = alreadyLoadedTranscription
          ? alreadyLoadedTranscription
          : reused
          ? ({ text: persistedTranscript, segments: [], duration: 0 } satisfies RecordingTranscription)
          : ((await transcribeRecording(
              openai,
              recording.file_path
            )) as RecordingTranscription);
        const segmentText = normalizeText(transcription.text);

        if (!segmentText || isDegenerateRecordingTranscript(segmentText)) {
          aggregateFailures.push({
            recordingId: recording.recording_id,
            filePath: recording.file_path,
            reason: segmentText ? "degenerate_transcription" : "empty_transcription",
          });
          elapsedSeconds += Number(recording.duration_seconds ?? 0);
          continue;
        }

        await prisma.$executeRaw`
          update public.interview_recordings
          set transcript = ${segmentText}
          where recording_id = ${recording.recording_id}::uuid
        `;

        aggregateTexts.push(segmentText);
        for (const segment of transcription.segments ?? []) {
          aggregateSegments.push({
            ...segment,
            start: elapsedSeconds + Number(segment.start ?? 0),
            end: elapsedSeconds + Number(segment.end ?? 0),
          });
        }
        const segmentDurationSeconds = Number(
          recording.duration_seconds ?? transcription.duration ?? 0
        );
        browserSegmentTimeline.push({
          recordingId: recording.recording_id,
          startSeconds: elapsedSeconds,
          endSeconds: elapsedSeconds + segmentDurationSeconds,
          text: segmentText,
        });
        if (!reused) {
          billedSeconds += Number(
            transcription.usage?.seconds ??
              transcription.duration ??
              recording.duration_seconds ??
              0
          );
        }
        elapsedSeconds += Number(
          recording.duration_seconds ?? transcription.duration ?? 0
        );
      } catch (error) {
        aggregateFailures.push({
          recordingId: recording.recording_id,
          filePath: recording.file_path,
          reason:
            error instanceof Error
              ? `transcription_unavailable:${error.message.slice(0, 180)}`
              : "transcription_unavailable",
        });
        elapsedSeconds += Number(recording.duration_seconds ?? 0);
      }
    }

    if (aggregateTexts.length > 1) {
      const transcriptText = aggregateTexts.join("\n\n");
      selectedTranscript = {
        recording: browserSegments[0],
        transcription: {
          text: transcriptText,
          segments: aggregateSegments,
          duration: elapsedSeconds,
          usage: { seconds: billedSeconds },
        },
        transcriptText,
        failures: aggregateFailures,
      };
      aggregateBilledAudioSeconds = billedSeconds;
      usedAggregatedBrowserSegments = true;
    }
  }

  for (const failure of selectedTranscript.failures) {
    console.warn("Recording transcription source rejected", {
      attemptId,
      recordingId: failure.recordingId,
      filePath: failure.filePath,
      reason: failure.reason,
    });
  }

  if (
    !selectedTranscript.recording ||
    !selectedTranscript.transcription ||
    !selectedTranscript.transcriptText
  ) {
    const sourceFailureSummary =
      selectedTranscript.failures
        .map((failure) => `${failure.recordingId}:${failure.reason}`)
        .join("; ")
        .slice(0, 500) || "No recording source produced a usable transcript";

    await releaseRepairLease({
      attemptId,
      token: leaseToken,
      recordingId: leaseRecording.recording_id,
      outcome: "failed",
      rawTranscriptPersisted: false,
      error: sourceFailureSummary,
    });

    return {
      repaired: codeRepair.repaired,
      skipped: "all_recording_sources_failed",
    };
  }

  const recording = selectedTranscript.recording;
  const transcription = selectedTranscript.transcription;
  const transcriptText = selectedTranscript.transcriptText;
  const reuseExistingTranscript = isReusableRecordingTranscript(
    recording.transcript
  );

  // Persist the costly Whisper result before optional answer alignment. If a
  // later step fails, every retry reuses this transcript instead of uploading
  // and billing the full recording again.
  if (!usedAggregatedBrowserSegments) {
    await prisma.$executeRaw`
      update public.interview_recordings
      set transcript = ${transcriptText}
      where recording_id = ${recording.recording_id}::uuid
    `;
  }

  const billedAudioSeconds = aggregateBilledAudioSeconds ?? (reuseExistingTranscript
    ? 0
    : Number(transcription.usage?.seconds
      ?? transcription.duration
      ?? 0));

  let alignmentUnavailable = false;
  const answersByOrder = new Map<number, string>();
  // Questions this invocation actually reached. Anything past the time budget
  // must not be recorded as "no usable answer", or an untouched question would
  // look permanently examined.
  const attemptedOrders = new Set<number>();

  if (aggregationIncomplete) {
    // Only part of the interview has been transcribed this pass. Aligning now
    // would map answers onto the wrong time windows, so the segment
    // transcripts persisted above are this pass's contribution and alignment
    // resumes once the full recording is transcribed.
    console.warn("Skipping alignment until every segment is transcribed", { attemptId });
  } else if (usedAggregatedBrowserSegments) {
    // A single call asking the model for all 12 answers at once pressures it
    // to compress each one to fit a short JSON response. Resolve each
    // question to only the segments that overlap its time window and align
    // them individually so nothing gets summarized away.
    try {
      const questionWindows = await fetchSegmentQuestionWindows(attemptId);
      const referenceStart = new Date(browserSegments[0].started_at ?? Date.now());
      const windowTranscripts = buildSegmentWindowTranscripts({
        referenceStart,
        timeline: browserSegmentTimeline,
        questionWindows,
      });

      for (const question of questions) {
        const windowTranscript = windowTranscripts.get(Number(question.question_order));
        if (!windowTranscript) continue;

        // One OpenAI round-trip per question. Stop while there is still time
        // to persist what has been recovered; the next pass resumes with the
        // questions that are still pending.
        if (outOfTime()) {
          budgetReached = true;
          console.warn("Repair time budget reached during alignment; resuming next pass", {
            attemptId,
            alignedSoFar: answersByOrder.size,
            remaining: questions.length - attemptedOrders.size,
          });
          break;
        }

        attemptedOrders.add(Number(question.question_order));
        try {
          const aligned = await alignAnswers(openai, [question], windowTranscript);
          const answer = normalizeText(aligned[0]?.answer);
          if (answer) {
            answersByOrder.set(Number(question.question_order), answer);
          }
        } catch (error) {
          console.error("Per-question windowed alignment failed", {
            attemptId,
            questionOrder: question.question_order,
            error,
          });
        }
      }
    } catch (error) {
      alignmentUnavailable = true;
      console.error("Segment-windowed answer alignment is temporarily unavailable", {
        attemptId,
        recordingId: recording.recording_id,
        error,
      });
    }
  } else {
    try {
      // A single call covers every question here, so all of them are examined.
      for (const question of questions) {
        attemptedOrders.add(Number(question.question_order));
      }
      const alignedAnswers = await alignAnswers(openai, questions, transcriptText);
      for (const aligned of alignedAnswers) {
        const order = Number(aligned.question_order);
        if (Number.isFinite(order)) {
          answersByOrder.set(order, normalizeText(aligned.answer) || "No response provided.");
        }
      }
    } catch (error) {
      // The recording transcript is still durable evidence even when the optional
      // AI alignment service is out of quota or temporarily unavailable. Keep the
      // transcript, finish the lifecycle, and leave missing answers for review.
      alignmentUnavailable = true;
      console.error("Recording answer alignment is temporarily unavailable", {
        attemptId,
        recordingId: recording.recording_id,
        error,
      });
    }
  }

  try {
    if (usedAggregatedBrowserSegments) {
      throw new Error("question_window_alignment_not_applicable_to_segmented_recording");
    }
    await recoverAnswersFromQuestionWindows({
      openai,
      attemptId,
      recording: recording as RepairRecordingRow,
      questions,
      answersByOrder,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "question_window_alignment_not_applicable_to_segmented_recording"
    ) {
      // Whole-transcript alignment above is authoritative for segmented audio.
    } else {
    console.error("Question-window transcript recovery failed", {
      attemptId,
      recordingId: recording.recording_id,
      error,
    });
    }
  }

  const segments = (transcription.segments ?? []).map((segment, index) => ({
    index: index + 1,
    startMs: Math.round(Number(segment.start ?? 0) * 1000),
    endMs: Math.round(Number(segment.end ?? 0) * 1000),
    transcript: normalizeText(segment.text),
  }));

  // Run AI evaluation for recovered answers before opening the transaction so
  // the network round-trips to OpenAI do not hold the DB transaction open.
  const recoveredEvaluationsByOrder = new Map<
    number,
    Awaited<ReturnType<typeof evaluateRecoveredAnswer>>
  >();
  for (const question of questions) {
    if (question.code_text) continue;
    const answer = answersByOrder.get(Number(question.question_order));
    if (
      !answer ||
      isNoResponse(answer) ||
      isUnsafeAlignedAnswer(answer) ||
      isInvalidCandidateTranscript({ transcript: answer, questionText: question.question })
    ) {
      continue;
    }
    if (!isRecoveredAnswerMateriallyBetter(question.answer_text, answer)) {
      continue;
    }

    // Another OpenAI round-trip each. The recovered answer text is worth more
    // than its score, so when time runs out the answer is still persisted
    // below and only its evaluation waits for the next pass.
    if (outOfTime()) {
      budgetReached = true;
      console.warn("Repair time budget reached during evaluation; resuming next pass", {
        attemptId,
        evaluated: recoveredEvaluationsByOrder.size,
      });
      break;
    }

    recoveredEvaluationsByOrder.set(
      Number(question.question_order),
      await evaluateRecoveredAnswer(question, answer)
    );
  }

  let repaired = 0;
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const question of questions) {
      if (question.code_text) {
        continue;
      }

      const answer = answersByOrder.get(Number(question.question_order));
      if (
        !answer ||
        isNoResponse(answer) ||
        isUnsafeAlignedAnswer(answer) ||
        isInvalidCandidateTranscript({
          transcript: answer,
          questionText: question.question,
        })
      ) {
        // Only questions this pass actually reached may be marked examined.
        // Marking one the time budget cut off would retire it as hopeless
        // without ever having looked at it.
        if (!alignmentUnavailable && attemptedOrders.has(Number(question.question_order))) {
          await tx.$executeRaw`
            update public.interview_answers
            set answer_payload = ${mergePayload(question.answer_payload, {
              recording_alignment_attempted_at: new Date().toISOString(),
              recording_alignment_attempted_id: recording.recording_id,
              recording_alignment_outcome: "no_usable_answer",
            })}::jsonb
            where answer_id = ${question.answer_id}::uuid
          `;
        }
        continue;
      }

      const shouldReplace = isRecoveredAnswerMateriallyBetter(question.answer_text, answer);
      const verificationFields = {
        recording_transcript_verified_at: new Date().toISOString(),
        recording_transcript_verified_id: recording.recording_id,
        recording_aligned_word_count: wordCount(answer),
        ...(shouldReplace
          ? {
              browser_transcript_before_recording_repair: question.answer_text,
              original_transcript: answer,
              raw_candidate_answer: answer,
              transcript_repaired_from_recording: true,
              transcript_repaired_at: new Date().toISOString(),
              repair_recording_id: recording.recording_id,
            }
          : {}),
      };

      await tx.$executeRaw`
        update public.interview_answers
        set answer_text = case when ${shouldReplace} then ${answer} else answer_text end,
            answer_payload = ${mergePayload(question.answer_payload, verificationFields)}::jsonb,
            status = 'completed'
        where answer_id = ${question.answer_id}::uuid
      `;

      if (!shouldReplace) {
        continue;
      }

      await tx.$executeRaw`
        insert into public.interview_signals (attempt_id, type, value)
        select
          ${attemptId}::uuid,
          'transcript_recovered_from_recording',
          ${JSON.stringify({
            sessionQuestionId: question.session_question_id,
            recordingId: recording.recording_id,
            recoveredWordCount: wordCount(answer),
            severity: "low",
            source: "recording_transcript_repair",
          })}::jsonb
        where not exists (
          select 1
          from public.interview_signals existing
          where existing.attempt_id = ${attemptId}::uuid
            and existing.type = 'transcript_recovered_from_recording'
            and coalesce(existing.value->>'sessionQuestionId', '') =
              coalesce(${question.session_question_id}, '')
        )
      `;

      const evaluation =
        recoveredEvaluationsByOrder.get(Number(question.question_order)) ??
        buildHeuristicRecoveredEvaluation(answer);
      await tx.$executeRaw`
        delete from public.interview_answer_evaluations
        where answer_id = ${question.answer_id}::uuid
          and evaluator_type = 'AI'
      `;
      await tx.$executeRaw`
        insert into public.interview_answer_evaluations (
          answer_id,
          evaluator_type,
          score,
          feedback,
          skill_score,
          clarity_score,
          depth_score,
          confidence_score,
          fraud_score,
          evaluation_json
        )
        values (
          ${question.answer_id}::uuid,
          'AI',
          ${evaluation.score},
          ${evaluation.feedback},
          ${evaluation.skill_score},
          ${evaluation.clarity_score},
          ${evaluation.depth_score},
          ${evaluation.confidence_score},
          ${evaluation.fraud_score},
          ${JSON.stringify(evaluation.evaluation_json)}::jsonb
        )
      `;
      repaired += 1;
    }

    if (segments.length > 0) {
      await tx.$executeRaw`
        delete from public.forensic_transcripts
        where attempt_id = ${attemptId}::uuid
      `;

      for (const segment of segments) {
        await tx.$executeRaw`
          insert into public.forensic_transcripts (
            attempt_id, segment_index, start_ms, end_ms, transcript
          )
          values (
            ${attemptId}::uuid,
            ${segment.index},
            ${segment.startMs},
            ${segment.endMs},
            ${segment.transcript}
          )
        `;
      }
    }

    await tx.$executeRaw`
      update public.interview_recordings
      set transcript = coalesce(nullif(btrim(transcript), ''), ${transcriptText})
      where recording_id = ${recording.recording_id}::uuid
    `;

    await tx.$executeRaw`
      update public.interview_attempts
      set transcript_status = case when ${repaired} > 0 then 'COMPLETED' else transcript_status end
      where attempt_id = ${attemptId}::uuid
    `;
  }, { timeout: 60_000 });

  await releaseRepairLease({
    attemptId,
    token: leaseToken,
    recordingId: recording.recording_id,
    outcome: alignmentUnavailable
      ? "partial"
      : budgetReached
        ? "incomplete"
        : "completed",
    rawTranscriptPersisted: true,
    billedAudioSeconds,
    error: alignmentUnavailable
      ? "Answer alignment unavailable"
      : budgetReached
        ? "Repair time budget reached; remaining answers resume on the next pass"
        : selectedTranscript.failures.length > 0
          ? `Recovered after source fallback: ${selectedTranscript.failures
              .map((failure) => `${failure.recordingId}:${failure.reason}`)
              .join("; ")
              .slice(0, 420)}`
          : null,
  });

  return {
    repaired: repaired + codeRepair.repaired,
    recordingId: recording.recording_id,
    ...(alignmentUnavailable
      ? { skipped: "recording_alignment_unavailable" }
      : budgetReached
        ? { skipped: "repair_time_budget_reached" }
        : {}),
  };
}

export async function validateAndRepairCompletionTranscripts(attemptId: string) {
  const createdPlaceholders = await createMissingAnswerPlaceholders(attemptId);
  const rejectedQuestionEchoes = await rejectQuestionEchoAnswers(attemptId);
  const repairResult = await repairPendingAnswersFromRecording(attemptId);
  const remainingIssues = await countRemainingCompletionIssues(attemptId);
  const repairedAnswers = Number(repairResult.repaired ?? 0);
  const status: CompletionTranscriptIntegrityResult["status"] =
    remainingIssues > 0
      ? "needs_review"
      : createdPlaceholders > 0 || rejectedQuestionEchoes > 0 || repairedAnswers > 0
        ? "repaired"
        : "clean";
  const result: CompletionTranscriptIntegrityResult = {
    checkedAt: new Date().toISOString(),
    createdPlaceholders,
    rejectedQuestionEchoes,
    repairedAnswers,
    remainingIssues,
    status,
    ...(repairResult.skipped ? { repairSkipped: repairResult.skipped } : {}),
  };

  await prisma.$executeRaw`
    update public.interview_attempts
    set transcript_status = case
          when ${remainingIssues} = 0 and transcript_status = 'FINALIZED' then 'FINALIZED'
          when ${remainingIssues} = 0 then 'COMPLETED'
          when ${createdPlaceholders + rejectedQuestionEchoes + repairedAnswers} > 0 then 'PARTIAL'
          else transcript_status
        end,
        termination_metadata = coalesce(termination_metadata, '{}'::jsonb) || ${JSON.stringify({
          transcript_integrity: result,
        })}::jsonb
    where attempt_id = ${attemptId}::uuid
  `;

  return result;
}

function formatCodingSubmission(language: string | null, code: string) {
  return `[Coding submission in ${language || "code"}]\n${code.trim()}`;
}

async function repairCodingAnswersFromSubmissions(attemptId: string) {
  const rows = await prisma.$queryRaw<Array<{
    answer_id: string;
    language: string | null;
    code_text: string | null;
  }>>`
    select
      ans.answer_id::text,
      cs.language,
      cs.code_text
    from public.interview_answers ans
    join public.interview_code_submissions cs
      on cs.answer_id = ans.answer_id
    where ans.attempt_id = ${attemptId}::uuid
      and cs.code_text is not null
      and nullif(btrim(cs.code_text), '') is not null
      and (
        nullif(btrim(coalesce(ans.answer_text, '')), '') is null
        or lower(btrim(coalesce(ans.answer_text, ''))) in ('no response provided', 'no response provided.')
      )
  `;

  let repaired = 0;
  for (const row of rows) {
    const answer = formatCodingSubmission(row.language, row.code_text || "");
    await prisma.$executeRaw`
      update public.interview_answers
      set answer_text = ${answer},
          answer_payload = coalesce(answer_payload, '{}'::jsonb) || ${JSON.stringify({
            answer_mode: "coding",
            coding_submission_repaired_from_code_table: true,
            coding_submission_repaired_at: new Date().toISOString(),
          })}::jsonb,
          status = 'completed'
      where answer_id = ${row.answer_id}::uuid
    `;
    repaired += 1;
  }

  return { repaired };
}
