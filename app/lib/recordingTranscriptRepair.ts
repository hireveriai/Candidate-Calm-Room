import OpenAI from "openai";
import { Prisma } from "@prisma/client";

import { prisma } from "@/app/lib/prisma";

type RepairQuestionRow = {
  answer_id: string;
  answer_payload: unknown | null;
  question_order: number | null;
  question: string | null;
};

type RepairRecordingRow = {
  recording_id: string;
  file_path: string;
  object_size: bigint | number | string | null;
};

type AlignedAnswer = {
  question_order?: number;
  answer?: string;
  evidence?: string;
  confidence?: number;
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
      coalesce((so.metadata->>'size')::bigint, 0) as object_size
    from public.interview_recordings ir
    left join storage.objects so
      on so.bucket_id = ${getRecordingBucket()}
     and so.name = ir.file_path
    where ir.attempt_id = ${attemptId}::uuid
      and ir.status = 'completed'
      and ir.file_path is not null
      and coalesce((so.metadata->>'size')::bigint, 0) > 0
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
  if (!process.env.OPENAI_API_KEY || !getSupabaseConfig()) {
    return { repaired: 0, skipped: "missing_configuration" };
  }

  const pendingRows = await prisma.$queryRaw<Array<{ answer_id: string }>>`
    select answer_id::text
    from public.interview_answers
    where attempt_id = ${attemptId}::uuid
      and (
        coalesce(status, '') in ('generating', 'failed')
        or nullif(btrim(coalesce(answer_text, '')), '') is null
        or lower(btrim(coalesce(answer_text, ''))) in ('no response provided', 'no response provided.')
      )
    limit 1
  `;

  if (pendingRows.length === 0) {
    return { repaired: 0, skipped: "no_pending_answers" };
  }

  const recording = await fetchBestRecording(attemptId);
  if (!recording) {
    return { repaired: 0, skipped: "no_usable_recording" };
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const questions = await fetchRepairQuestions(attemptId);
  const transcription = await transcribeRecording(openai, recording.file_path);
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
      const answer = answersByOrder.get(Number(question.question_order));
      if (!answer || isNoResponse(answer)) {
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

  return { repaired, recordingId: recording.recording_id };
}
