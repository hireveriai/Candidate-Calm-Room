/* eslint-disable @typescript-eslint/no-require-imports */
require("dotenv").config({ path: ".env.local" });

if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const { Client } = require("pg");
const OpenAI = require("openai");

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const args = {
    apply: false,
    all: false,
    attemptId: "",
    limit: 10,
    includeClean: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") args.apply = true;
    else if (value === "--all") args.all = true;
    else if (value === "--include-clean") args.includeClean = true;
    else if (value === "--attempt") args.attemptId = argv[++index] ?? "";
    else if (value === "--limit") args.limit = Number(argv[++index] ?? args.limit);
  }

  return args;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isNoResponse(value) {
  return /^no response provided\.?$/i.test(normalizeText(value));
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function fetchObjectBuffer(filePath) {
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const bucket =
    process.env.RECORDING_S3_BUCKET?.trim() ||
    process.env.SUPABASE_STORAGE_BUCKET?.trim() ||
    "recordings";

  if (!filePath) {
    throw new Error("Recording does not have a file_path");
  }

  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const url = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
  const response = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch recording object ${filePath}: ${response.status} ${await response.text()}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function fetchAttemptRecordingObjects(client, attemptId) {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || "recordings";
  const result = await client.query(
    `
      select
        ir.recording_id::text,
        ir.file_path,
        coalesce((so.metadata->>'size')::bigint, 0) as object_size
      from public.interview_recordings ir
      left join storage.objects so
        on so.bucket_id = $2::text
       and so.name = ir.file_path
      where ir.attempt_id = $1::uuid
        and ir.status = 'completed'
        and ir.file_path is not null
        and coalesce((so.metadata->>'size')::bigint, 0) > 0
        and coalesce((so.metadata->>'size')::bigint, 0) <= 24000000
      order by coalesce(ir.started_at, ir.created_at) asc,
               coalesce(ir.ended_at, ir.created_at) asc
    `,
    [attemptId, bucket]
  );

  return result.rows;
}

async function transcribeRecording(openai, buffer) {
  const file = new File([buffer], "recording.mp4", { type: "video/mp4" });
  return openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
    temperature: 0,
  });
}

async function transcribeAttemptRecordings(client, openai, attemptId) {
  const recordings = await fetchAttemptRecordingObjects(client, attemptId);
  if (recordings.length === 0) {
    throw new Error(`No usable completed recording objects found for attempt ${attemptId}`);
  }

  const transcriptions = [];
  for (const recording of recordings) {
    const buffer = await fetchObjectBuffer(recording.file_path);
    const transcription = await transcribeRecording(openai, buffer);
    transcriptions.push({ recording, transcription });
  }

  let offsetSeconds = 0;
  const segments = [];
  const textParts = [];

  for (const item of transcriptions) {
    const sourceSegments = item.transcription.segments ?? [];
    for (const segment of sourceSegments) {
      const start = Number(segment.start ?? 0) + offsetSeconds;
      const end = Number(segment.end ?? 0) + offsetSeconds;
      segments.push({
        ...segment,
        start,
        end,
        text: normalizeText(segment.text),
      });
    }

    const text = normalizeText(item.transcription.text);
    if (text) textParts.push(text);

    const lastEnd = sourceSegments.reduce(
      (max, segment) => Math.max(max, Number(segment.end ?? 0)),
      0
    );
    offsetSeconds += Math.max(lastEnd, 1) + 1;
  }

  return {
    text: textParts.join(" "),
    segments,
    recordingCount: recordings.length,
  };
}

async function alignAnswers(openai, questions, transcript) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You align an interview recording transcript to the exact ordered questions.",
          "Return only JSON: {\"answers\":[{\"question_order\":number,\"answer\":string,\"evidence\":string,\"confidence\":number,\"skill_score\":number,\"clarity_score\":number,\"depth_score\":number,\"confidence_score\":number,\"fraud_score\":number,\"reasoning\":string}]}",
          "Use only words and meaning supported by the transcript.",
          "Do not invent coding submissions, examples, tools, metrics, or polished content.",
          "If the candidate did not substantively answer a question, use exactly \"No response provided.\"",
          "Exclude interviewer questions from candidate answers.",
          "All score fields must be numbers from 0 to 1.",
          "Set skill_score, clarity_score, depth_score, and confidence_score to 0 for no-response answers.",
          "Fraud score is about authenticity risk only. Do not treat a missing answer as fraud.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            questions,
            transcript: normalizeText(transcript).slice(0, 60000),
          },
          null,
          2
        ),
      },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "{}";
  const parsed = safeJsonParse(content, { answers: [] });
  return Array.isArray(parsed.answers) ? parsed.answers : [];
}

async function evaluateAnswer(openai, question, answer) {
  if (isNoResponse(answer)) {
    return {
      skill_score: 0,
      clarity_score: 0,
      depth_score: 0,
      confidence_score: 0,
      fraud_score: 0,
      reasoning: "No substantive response was provided for this question.",
      evaluation_json: { mode: "repair_no_response" },
    };
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Evaluate a spoken interview answer. Return only JSON with skill_score, clarity_score, depth_score, confidence_score, fraud_score from 0 to 1 and a concise reasoning string. Do not inflate vague answers.",
      },
      {
        role: "user",
        content: JSON.stringify({ question, answer }),
      },
    ],
  });

  const parsed = safeJsonParse(response.choices[0]?.message?.content ?? "{}", {});
  const score = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
  };

  return {
    skill_score: score(parsed.skill_score),
    clarity_score: score(parsed.clarity_score),
    depth_score: score(parsed.depth_score),
    confidence_score: score(parsed.confidence_score),
    fraud_score: Math.min(score(parsed.fraud_score), 0.25),
    reasoning:
      typeof parsed.reasoning === "string"
        ? parsed.reasoning
        : "Evaluation recomputed after transcript repair.",
    evaluation_json: { ...parsed, mode: "recomputed_after_recording_transcript_repair" },
  };
}

function evaluationFromAligned(aligned, answer) {
  const score = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : null;
  };
  const skill = score(aligned?.skill_score);
  const clarity = score(aligned?.clarity_score);
  const depth = score(aligned?.depth_score);
  const confidence = score(aligned?.confidence_score);
  const fraud = score(aligned?.fraud_score);

  if ([skill, clarity, depth, confidence, fraud].some((value) => value === null)) {
    return null;
  }

  if (isNoResponse(answer)) {
    return {
      skill_score: 0,
      clarity_score: 0,
      depth_score: 0,
      confidence_score: 0,
      fraud_score: 0,
      reasoning: "No substantive response was provided for this question.",
      evaluation_json: { mode: "repair_aligned_no_response" },
    };
  }

  return {
    skill_score: skill,
    clarity_score: clarity,
    depth_score: depth,
    confidence_score: confidence,
    fraud_score: Math.min(fraud, 0.25),
    reasoning:
      typeof aligned.reasoning === "string" && aligned.reasoning.trim()
        ? aligned.reasoning.trim()
        : "Evaluation recomputed after transcript repair.",
    evaluation_json: {
      mode: "aligned_and_scored_after_recording_transcript_repair",
      evidence: typeof aligned.evidence === "string" ? aligned.evidence : null,
      alignment_confidence: score(aligned.confidence),
    },
  };
}

async function fetchTargets(client, args) {
  if (args.attemptId) {
    if (!uuidPattern.test(args.attemptId)) throw new Error("--attempt must be a valid UUID");
    const result = await client.query(
      `
        select
          ia.attempt_id::text,
          ir.recording_id::text,
          ir.file_path,
          ir.video_url,
          ir.audio_url,
          coalesce((so.metadata->>'size')::bigint, 0) as object_size,
          coalesce(c.full_name, 'Unknown candidate') as candidate_name
        from public.interview_attempts ia
        join public.interview_recordings ir on ir.attempt_id = ia.attempt_id
        left join storage.objects so
          on so.bucket_id = $2::text
         and so.name = ir.file_path
        left join public.interviews i on i.interview_id = ia.interview_id
        left join public.candidates c on c.candidate_id = i.candidate_id
        where ia.attempt_id = $1::uuid
          and ir.status = 'completed'
          and ir.file_path is not null
          and coalesce((so.metadata->>'size')::bigint, 0) <= 24000000
        order by coalesce((so.metadata->>'size')::bigint, 0) desc,
                 coalesce(ir.ended_at, ir.created_at) desc
        limit 1
      `,
      [args.attemptId, process.env.SUPABASE_STORAGE_BUCKET?.trim() || "recordings"]
    );
    return result.rows;
  }

  if (!args.all) {
    throw new Error("Use --attempt <id> or --all");
  }

  const result = await client.query(
    `
      with answer_health as (
        select
          ia.attempt_id,
          count(ans.answer_id)::int as answer_count,
          count(*) filter (
            where lower(trim(coalesce(ans.answer_text, ''))) in ('no response provided', 'no response provided.')
              or ans.answer_payload ? 'llm'
          )::int as suspect_count,
          bool_or((ans.answer_payload->>'transcript_repaired_from_recording')::boolean) as already_repaired
        from public.interview_attempts ia
        left join public.interview_answers ans on ans.attempt_id = ia.attempt_id
        group by ia.attempt_id
      ),
      ranked_recordings as (
        select
          ir.*,
          coalesce((so.metadata->>'size')::bigint, 0) as object_size,
          row_number() over (
            partition by ir.attempt_id
            order by coalesce((so.metadata->>'size')::bigint, 0) desc,
                     coalesce(ir.ended_at, ir.created_at) desc
          ) as recording_rank
        from public.interview_recordings ir
        left join storage.objects so
          on so.bucket_id = $3::text
         and so.name = ir.file_path
        where ir.status = 'completed'
          and ir.file_path is not null
      )
      select
        ia.attempt_id::text,
        ir.recording_id::text,
        ir.file_path,
        ir.video_url,
        ir.audio_url,
        coalesce(c.full_name, 'Unknown candidate') as candidate_name,
        ah.answer_count,
        ah.suspect_count,
        ir.object_size
      from public.interview_attempts ia
      join answer_health ah on ah.attempt_id = ia.attempt_id
      join ranked_recordings ir on ir.attempt_id = ia.attempt_id and ir.recording_rank = 1
      left join public.interviews i on i.interview_id = ia.interview_id
      left join public.candidates c on c.candidate_id = i.candidate_id
      where ah.answer_count > 0
        and ($1::boolean or ah.suspect_count > 0)
        and coalesce(ah.already_repaired, false) = false
        and ir.object_size > 0
        and ir.object_size <= 24000000
      order by ir.object_size asc, ia.started_at desc nulls last
      limit $2
    `,
    [
      args.includeClean,
      Number.isFinite(args.limit) ? args.limit : 10,
      process.env.SUPABASE_STORAGE_BUCKET?.trim() || "recordings",
    ]
  );

  return result.rows;
}

async function fetchQuestions(client, attemptId) {
  const result = await client.query(
    `
      select
        ans.answer_id::text,
        ans.answer_payload,
        iae.evaluation_id::text,
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
      left join public.interview_answer_evaluations iae on iae.answer_id = ans.answer_id
      where ans.attempt_id = $1::uuid
      order by coalesce(sq.question_order, iq.question_order) asc nulls last, ans.answered_at asc nulls last
    `,
    [attemptId]
  );

  return result.rows.map((row, index) => ({
    ...row,
    question_order: Number(row.question_order ?? index + 1),
    question: normalizeText(row.question),
  }));
}

function buildRecordingTranscript(questions, answersByOrder) {
  return questions
    .map((row) => {
      const answer = answersByOrder.get(row.question_order) ?? "No response provided.";
      return `VERIS Q${row.question_order}: ${row.question} Candidate A${row.question_order}: ${normalizeText(answer)}`;
    })
    .join(" ");
}

async function persistRepair(client, openai, target, transcription, alignedAnswers, dryRun) {
  const questions = await fetchQuestions(client, target.attempt_id);
  const answersByOrder = new Map();

  for (const question of questions) {
    const aligned = alignedAnswers.find(
      (item) => Number(item.question_order) === question.question_order
    );
    answersByOrder.set(
      question.question_order,
      normalizeText(aligned?.answer) || "No response provided."
    );
  }

  const evaluations = [];
  for (const question of questions) {
    const answer = answersByOrder.get(question.question_order);
    const aligned = alignedAnswers.find(
      (item) => Number(item.question_order) === question.question_order
    );
    evaluations.push({
      question,
      answer,
      evaluation:
        evaluationFromAligned(aligned, answer) ??
        (await evaluateAnswer(openai, question.question, answer)),
    });
  }

  const substantive = evaluations.filter((item) => !isNoResponse(item.answer));
  const overallScore =
    substantive.length === 0
      ? null
      : Math.round(
          (substantive.reduce((total, item) => {
            const ev = item.evaluation;
            return (
              total +
              (ev.skill_score * 0.4 +
                ev.clarity_score * 0.2 +
                ev.depth_score * 0.2 +
                ev.confidence_score * 0.15 +
                Math.max(0, 1 - ev.fraud_score) * 0.05)
            );
          }, 0) /
            substantive.length) *
            100
        );
  const maxFraud = evaluations.reduce(
    (max, item) => Math.max(max, item.evaluation.fraud_score),
    0
  );
  const riskLevel = maxFraud >= 0.7 ? "HIGH" : maxFraud >= 0.4 ? "MEDIUM" : "LOW";
  const recommendation =
    overallScore === null ? "REJECT" : overallScore >= 75 ? "HIRE" : overallScore >= 60 ? "REVIEW" : "REJECT";
  const recordingTranscript = buildRecordingTranscript(questions, answersByOrder);
  const segments = (transcription.segments ?? []).map((segment, index) => ({
    index: index + 1,
    startMs: Math.round(Number(segment.start ?? 0) * 1000),
    endMs: Math.round(Number(segment.end ?? 0) * 1000),
    transcript: normalizeText(segment.text),
  }));

  const evidenceTooThin =
    substantive.length === 0 && questions.length > 1 && segments.length < questions.length;

  if (dryRun) {
    return {
      updatedAnswers: questions.length,
      substantiveAnswers: substantive.length,
      forensicSegments: segments.length,
      overallScore,
      riskLevel,
      recommendation,
      evidenceTooThin,
      answerPreviews: questions.map((question) => ({
        order: question.question_order,
        answer: normalizeText(answersByOrder.get(question.question_order)).slice(0, 140),
      })),
      dryRun: true,
    };
  }

  if (evidenceTooThin) {
    return {
      updatedAnswers: 0,
      substantiveAnswers: substantive.length,
      forensicSegments: segments.length,
      overallScore,
      riskLevel,
      recommendation,
      skipped: true,
      reason: "Recording transcription evidence was too thin to safely overwrite answers.",
      dryRun: false,
    };
  }

  await client.query("begin");
  try {
    for (const item of evaluations) {
      const payload = {
        ...(item.question.answer_payload && typeof item.question.answer_payload === "object"
          ? item.question.answer_payload
          : {}),
        original_transcript: item.answer,
        raw_candidate_answer: item.answer,
        transcript_repaired_from_recording: true,
        transcript_repaired_at: new Date().toISOString(),
      };
      await client.query(
        `
          update public.interview_answers
          set answer_text = $2::text,
              answer_payload = $3::jsonb,
              status = 'completed'
          where answer_id = $1::uuid
        `,
        [item.question.answer_id, item.answer, JSON.stringify(payload)]
      );

      const ev = item.evaluation;
      const score = Math.round(ev.skill_score * 1000) / 100;
      const evaluationJson = {
        ...ev.evaluation_json,
        transcript_repaired_from_recording: true,
        transcript_repaired_at: new Date().toISOString(),
      };

      if (item.question.evaluation_id) {
        await client.query(
          `
            update public.interview_answer_evaluations
            set evaluator_type = 'AI',
                score = $2::numeric,
                feedback = $3::text,
                evaluated_at = now(),
                skill_score = $4::numeric,
                clarity_score = $5::numeric,
                depth_score = $6::numeric,
                confidence_score = $7::numeric,
                fraud_score = $8::numeric,
                evaluation_json = $9::jsonb
            where evaluation_id = $1::uuid
          `,
          [
            item.question.evaluation_id,
            score,
            ev.reasoning,
            ev.skill_score,
            ev.clarity_score,
            ev.depth_score,
            ev.confidence_score,
            ev.fraud_score,
            JSON.stringify(evaluationJson),
          ]
        );
      } else {
        await client.query(
          `
            insert into public.interview_answer_evaluations (
              answer_id, evaluator_type, score, feedback, evaluated_at,
              skill_score, clarity_score, depth_score, confidence_score, fraud_score, evaluation_json
            )
            values ($1::uuid, 'AI', $2::numeric, $3::text, now(), $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::jsonb)
          `,
          [
            item.question.answer_id,
            score,
            ev.reasoning,
            ev.skill_score,
            ev.clarity_score,
            ev.depth_score,
            ev.confidence_score,
            ev.fraud_score,
            JSON.stringify(evaluationJson),
          ]
        );
      }
    }

    await client.query("delete from public.forensic_transcripts where attempt_id = $1::uuid", [
      target.attempt_id,
    ]);

    for (const segment of segments) {
      await client.query(
        `
          insert into public.forensic_transcripts (
            attempt_id, segment_index, start_ms, end_ms, transcript,
            confidence, stress, hesitation, cognitive_flag
          )
          values ($1::uuid, $2::int, $3::int, $4::int, $5::text, null, null, null, null)
        `,
        [
          target.attempt_id,
          segment.index,
          segment.startMs,
          segment.endMs,
          segment.transcript,
        ]
      );
    }

    await client.query(
      `
        update public.interview_recordings
        set transcript = $2::text
        where recording_id = $1::uuid
      `,
      [target.recording_id, recordingTranscript]
    );

    if (overallScore !== null) {
      await client.query(
        `
          insert into public.interview_summaries (
            attempt_id, overall_score, risk_level, strengths, weaknesses,
            hire_recommendation, created_at
          )
          values ($1::uuid, $2::int, $3::text, $4::text, $5::text, $6::text, now())
          on conflict (attempt_id) do update
          set overall_score = excluded.overall_score,
              risk_level = excluded.risk_level,
              strengths = excluded.strengths,
              weaknesses = excluded.weaknesses,
              hire_recommendation = excluded.hire_recommendation
        `,
        [
          target.attempt_id,
          overallScore,
          riskLevel,
          "Transcript repaired from the actual interview recording.",
          "Review answer-level evidence for no-response or low-specificity questions.",
          recommendation,
        ]
      );
    }

    await client.query(
      "update public.interview_attempts set transcript_status = 'COMPLETED' where attempt_id = $1::uuid",
      [target.attempt_id]
    );

    await client.query("commit");
    return {
      updatedAnswers: questions.length,
      forensicSegments: segments.length,
      overallScore,
      riskLevel,
      recommendation,
      dryRun: false,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const client = new Client({
    connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  });
  const openai = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });

  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    throw new Error("Missing DATABASE_URL or POSTGRES_URL");
  }

  await client.connect();
  const targets = await fetchTargets(client, args);
  const results = [];

  for (const target of targets) {
    console.log(
      JSON.stringify({
        event: "repair.start",
        attemptId: target.attempt_id,
        candidate: target.candidate_name,
        recordingId: target.recording_id,
      })
    );
    const transcription = await transcribeAttemptRecordings(
      client,
      openai,
      target.attempt_id
    );
    const questions = await fetchQuestions(client, target.attempt_id);
    const alignedAnswers = await alignAnswers(
      openai,
      questions.map((question) => ({
        question_order: question.question_order,
        question: question.question,
      })),
      transcription.text ?? ""
    );
    const result = await persistRepair(
      client,
      openai,
      target,
      transcription,
      alignedAnswers,
      !args.apply
    );
    results.push({
      attemptId: target.attempt_id,
      candidate: target.candidate_name,
      ...result,
    });
    console.log(JSON.stringify({ event: "repair.done", ...results[results.length - 1] }));
  }

  await client.end();
  console.log(JSON.stringify({ apply: args.apply, repaired: results.length, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
