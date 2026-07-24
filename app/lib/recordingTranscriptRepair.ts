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

type RepairQuestionRow = {
  answer_id: string;
  answer_payload: unknown | null;
  question_order: number | null;
  question: string | null;
  answer_text: string | null;
  code_text: string | null;
  language: string | null;
};

type RepairRecordingRow = {
  recording_id: string;
  file_path: string;
  transcript: string | null;
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

type RepairLeaseOutcome = "completed" | "failed" | "partial";

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
      ans.answer_payload,
      ans.answer_text,
      cs.code_text,
      cs.language,
      coalesce(sq.question_order, iq.question_order) as question_order,
      coalesce(sq.content, iq.question_text, q.question_text) as question
    from public.interview_answers ans
    left join public.session_questions sq
      on sq.session_question_id = ans.session_question_id
      or (sq.attempt_id = ans.attempt_id and sq.question_id = ans.question_id)
    left join public.interview_attempts att on att.attempt_id = ans.attempt_id
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

async function fetchRepairRecordings(attemptId: string) {
  const rows = await prisma.$queryRaw<RepairRecordingRow[]>`
    select
      ir.recording_id::text,
      ir.file_path,
      ir.transcript,
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
  `;

  return prioritizeRecordingCandidates(rows);
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
  const failed = params.outcome !== "completed";
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
  let uploadType = filePath.toLowerCase().includes(".mp4") ? "video/mp4" : "video/webm";

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
    prompt: "English technical job interview. Transcribe only clearly audible speech. Do not repeat phrases to fill silence.",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
    temperature: 0,
  });
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

function buildRecoveredEvaluation(answer: string) {
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
    feedback: "Auto-recovered from finalized interview recording because live speech recognition did not capture this answer.",
    evaluation_json: {
      mode: "recording_auto_repair",
      word_count: words,
      has_specificity: hasSpecificity,
    },
  };
}

function skillWeightedScore(clarity: number, depth: number, confidence: number) {
  return clarity * 0.35 + depth * 0.45 + confidence * 0.2;
}

export async function repairPendingAnswersFromRecording(attemptId: string) {
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
  const hasAnswerNeedingRecordingCheck = spokenRows.some((row: RepairQuestionRow) =>
    hasUnverifiedIncompleteSpokenAnswer(row)
  );

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

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 120_000,
    maxRetries: 1,
  });
  const questions = await fetchRepairQuestions(attemptId);
  const selectedTranscript = await findFirstUsableRecordingTranscript(
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
  await prisma.$executeRaw`
    update public.interview_recordings
    set transcript = ${transcriptText}
    where recording_id = ${recording.recording_id}::uuid
  `;

  const billedAudioSeconds = reuseExistingTranscript
    ? 0
    : Number(transcription.usage?.seconds
      ?? transcription.duration
      ?? 0);

  let alignmentUnavailable = false;
  let alignedAnswers: AlignedAnswer[] = [];
  try {
    alignedAnswers = await alignAnswers(openai, questions, transcriptText);
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
  const answersByOrder = new Map<number, string>();

  for (const aligned of alignedAnswers) {
    const order = Number(aligned.question_order);
    if (Number.isFinite(order)) {
      answersByOrder.set(order, normalizeText(aligned.answer) || "No response provided.");
    }
  }

  const segments = (transcription.segments ?? []).map((segment, index) => ({
    index: index + 1,
    startMs: Math.round(Number(segment.start ?? 0) * 1000),
    endMs: Math.round(Number(segment.end ?? 0) * 1000),
    transcript: normalizeText(segment.text),
  }));

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
        if (!alignmentUnavailable) {
          await tx.$executeRaw`
            update public.interview_answers
            set answer_payload = ${mergePayload(question.answer_payload, {
              recording_transcript_verified_at: new Date().toISOString(),
              recording_transcript_verified_id: recording.recording_id,
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

      const evaluation = buildRecoveredEvaluation(answer);
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
    outcome: alignmentUnavailable ? "partial" : "completed",
    rawTranscriptPersisted: true,
    billedAudioSeconds,
    error: alignmentUnavailable
      ? "Answer alignment unavailable"
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
    ...(alignmentUnavailable ? { skipped: "recording_alignment_unavailable" } : {}),
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
