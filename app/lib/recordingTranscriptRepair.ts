import OpenAI from "openai";
import { Prisma } from "@prisma/client";

import { prisma } from "@/app/lib/prisma";
import { isInvalidCandidateTranscript } from "@/app/lib/transcriptGuards";

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
};

type AlignedAnswer = {
  question_order?: number;
  answer?: string;
  evidence?: string;
  confidence?: number;
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

const MAX_REPAIR_OBJECT_BYTES = 24_000_000;

function normalizeText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isNoResponse(value: unknown) {
  return /^no response provided\.?$/i.test(normalizeText(value));
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

async function fetchBestRecording(attemptId: string) {
  const rows = await prisma.$queryRaw<RepairRecordingRow[]>`
    select
      ir.recording_id::text,
      ir.file_path,
      ir.transcript,
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
    order by extract(epoch from (coalesce(ir.ended_at, ir.created_at, now()) - coalesce(ir.started_at, ir.created_at, now()))) desc nulls last,
             case when ir.file_path ilike '%.mp4%' then 0 else 1 end,
             coalesce(ir.started_at, ir.created_at) asc
    limit 1
  `;

  return rows[0] ?? null;
}

async function transcribeRecording(openai: OpenAI, filePath: string) {
  const buffer = await fetchObjectBuffer(filePath);
  const file = new File([buffer], "recording.mp4", { type: "video/mp4" });

  return openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
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

  const pendingRows = await prisma.$queryRaw<Array<{ answer_id: string }>>`
    select ans.answer_id::text
    from public.interview_answers ans
    left join public.interview_code_submissions cs
      on cs.answer_id = ans.answer_id
    where ans.attempt_id = ${attemptId}::uuid
      and cs.answer_id is null
      and (
        coalesce(ans.status, '') in ('generating', 'failed')
        or nullif(btrim(coalesce(ans.answer_text, '')), '') is null
        or lower(btrim(coalesce(ans.answer_text, ''))) in ('no response provided', 'no response provided.')
      )
    limit 1
  `;

  if (pendingRows.length === 0) {
    return codeRepair.repaired > 0
      ? { repaired: codeRepair.repaired, skipped: "no_spoken_pending_answers" }
      : { repaired: 0, skipped: "no_pending_answers" };
  }

  if (!process.env.OPENAI_API_KEY || !getSupabaseConfig()) {
    return codeRepair.repaired > 0
      ? { repaired: codeRepair.repaired, skipped: "missing_spoken_repair_configuration" }
      : { repaired: 0, skipped: "missing_configuration" };
  }

  const recording = await fetchBestRecording(attemptId);
  if (!recording) {
    return { repaired: 0, skipped: "no_usable_recording" };
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const questions = await fetchRepairQuestions(attemptId);
  const existingRecordingTranscript = normalizeText(recording.transcript);
  const transcription = existingRecordingTranscript
    ? { text: existingRecordingTranscript, segments: [] }
    : await transcribeRecording(openai, recording.file_path);
  const transcriptText = normalizeText(transcription.text);

  if (!transcriptText) {
    return { repaired: 0, skipped: "empty_transcription" };
  }

  const alignedAnswers = await alignAnswers(openai, questions, transcriptText);
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
        isInvalidCandidateTranscript({
          transcript: answer,
          questionText: question.question,
        })
      ) {
        continue;
      }

      await tx.$executeRaw`
        update public.interview_answers
        set answer_text = ${answer},
            answer_payload = ${mergePayload(question.answer_payload, {
              original_transcript: answer,
              raw_candidate_answer: answer,
              transcript_repaired_from_recording: true,
              transcript_repaired_at: new Date().toISOString(),
              repair_recording_id: recording.recording_id,
            })}::jsonb,
            status = 'completed'
        where answer_id = ${question.answer_id}::uuid
          and (
            coalesce(status, '') in ('generating', 'failed')
            or nullif(btrim(coalesce(answer_text, '')), '') is null
            or lower(btrim(coalesce(answer_text, ''))) in ('no response provided', 'no response provided.')
          )
      `;

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
  });

  return { repaired: repaired + codeRepair.repaired, recordingId: recording.recording_id };
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
