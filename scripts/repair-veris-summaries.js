/* eslint-disable @typescript-eslint/no-require-imports */
require("dotenv").config({ path: ".env.local" });

if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const { Client } = require("pg");

function parseArgs(argv) {
  const args = {
    apply: false,
    all: false,
    attemptId: "",
    limit: 50,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") args.apply = true;
    else if (value === "--all") args.all = true;
    else if (value === "--attempt") args.attemptId = argv[++index] ?? "";
    else if (value === "--limit") args.limit = Number(argv[++index] ?? args.limit);
  }

  return args;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function wordCount(value) {
  return normalizeText(value).split(/\s+/).filter(Boolean).length;
}

function clipWords(value, maxWords) {
  const words = normalizeText(value).split(/\s+/).filter(Boolean);
  return words.length <= maxWords
    ? words.join(" ")
    : `${words.slice(0, maxWords).join(" ")}...`;
}

function isSubstantive(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized && normalized !== "no response provided.";
}

function normalizeDecision(value, score) {
  const normalized = normalizeText(value).toUpperCase();
  if (["HIRE", "REVIEW", "REJECT"].includes(normalized)) return normalized;
  if (score === null) return "REVIEW";
  if (score >= 75) return "HIRE";
  if (score >= 60) return "REVIEW";
  return "REJECT";
}

function normalizeRisk(value, fraudScore) {
  const normalized = normalizeText(value).toUpperCase();
  if (["LOW", "MEDIUM", "HIGH"].includes(normalized)) return normalized;
  if (fraudScore >= 0.7) return "HIGH";
  if (fraudScore >= 0.4) return "MEDIUM";
  return "LOW";
}

async function fetchTargets(client, args) {
  if (args.attemptId) {
    const result = await client.query(
      `
        select ia.attempt_id::text, coalesce(c.full_name, 'Unknown candidate') as candidate_name
        from public.interview_attempts ia
        left join public.interviews i on i.interview_id = ia.interview_id
        left join public.candidates c on c.candidate_id = i.candidate_id
        where ia.attempt_id = $1::uuid
      `,
      [args.attemptId]
    );
    return result.rows;
  }

  if (!args.all) {
    throw new Error("Use --attempt <id> or --all");
  }

  const result = await client.query(
    `
      with evidence as (
        select
          ia.attempt_id,
          coalesce(c.full_name, 'Unknown candidate') as candidate_name,
          char_length(coalesce(ie.ai_summary, '')) as summary_length,
          greatest(
            coalesce(recording_evidence.evidence_length, 0),
            coalesce(forensic_evidence.evidence_length, 0),
            coalesce(answer_evidence.evidence_length, 0)
          ) as evidence_length
        from public.interview_attempts ia
        left join public.interviews i on i.interview_id = ia.interview_id
        left join public.candidates c on c.candidate_id = i.candidate_id
        left join public.interview_evaluations ie on ie.attempt_id = ia.attempt_id
        left join lateral (
          select max(char_length(ir.transcript)) as evidence_length
          from public.interview_recordings ir
          where ir.attempt_id = ia.attempt_id
            and ir.transcript is not null
            and btrim(ir.transcript) <> ''
        ) recording_evidence on true
        left join lateral (
          select char_length(string_agg(ft.transcript, ' ' order by ft.segment_index)) as evidence_length
          from public.forensic_transcripts ft
          where ft.attempt_id = ia.attempt_id
        ) forensic_evidence on true
        left join lateral (
          select char_length(string_agg(ans.answer_text, ' ' order by ans.answered_at)) as evidence_length
          from public.interview_answers ans
          where ans.attempt_id = ia.attempt_id
            and ans.answer_text is not null
            and btrim(ans.answer_text) <> ''
        ) answer_evidence on true
        where upper(coalesce(ia.status, '')) in ('COMPLETED', 'FINALIZED', 'TIME_EXPIRED', 'ABANDONED')
           or ia.ended_at is not null
      )
      select attempt_id::text, candidate_name, summary_length, evidence_length
      from evidence
      where evidence_length >= 500
        and summary_length < greatest(500, least(1600, evidence_length * 0.12))
      order by evidence_length desc
      limit $1
    `,
    [Number.isFinite(args.limit) ? args.limit : 50]
  );

  return result.rows;
}

async function fetchEvidence(client, attemptId) {
  const answerResult = await client.query(
    `
        select
          sq.question_order,
          sq.content as question,
          coalesce(nullif(btrim(ans.answer_text), ''), nullif(btrim(cs.code_text), '')) as answer,
          iae.skill_score,
          iae.clarity_score,
          iae.depth_score,
          iae.confidence_score,
          iae.fraud_score
        from public.session_questions sq
        left join public.interview_answers ans
          on ans.session_question_id = sq.session_question_id
        left join public.interview_code_submissions cs
          on cs.answer_id = ans.answer_id
        left join public.interview_answer_evaluations iae
          on iae.answer_id = ans.answer_id
         and iae.evaluator_type = 'AI'
        where sq.attempt_id = $1::uuid
        order by sq.question_order asc nulls last, sq.asked_at asc nulls last
      `,
    [attemptId]
  );

  const transcriptResult = await client.query(
    `
        select transcript
        from (
          select string_agg(ft.transcript, ' ' order by ft.segment_index asc) as transcript
          from public.forensic_transcripts ft
          where ft.attempt_id = $1::uuid

          union all

          select ir.transcript
          from public.interview_recordings ir
          where ir.attempt_id = $1::uuid
            and ir.transcript is not null
            and btrim(ir.transcript) <> ''
        ) sources
        where transcript is not null and btrim(transcript) <> ''
        order by char_length(transcript) desc
        limit 1
      `,
    [attemptId]
  );

  const scoreResult = await client.query(
    `
        select
          ie.final_score,
          ie.decision,
          s.risk_level,
          s.hire_recommendation
        from public.interview_attempts ia
        left join public.interview_evaluations ie on ie.attempt_id = ia.attempt_id
        left join public.interview_summaries s on s.attempt_id = ia.attempt_id
        where ia.attempt_id = $1::uuid
        limit 1
      `,
    [attemptId]
  );

  return {
    answers: answerResult.rows
      .map((row) => ({
        order: Number(row.question_order),
        question: normalizeText(row.question),
        answer: normalizeText(row.answer),
        fraudScore: Number(row.fraud_score ?? 0),
      }))
      .filter((row) => isSubstantive(row.answer)),
    transcript: normalizeText(transcriptResult.rows[0]?.transcript),
    score: scoreResult.rows[0] ?? {},
  };
}

function buildSummary(evidence) {
  const answerWords = evidence.answers.reduce((total, row) => total + wordCount(row.answer), 0);
  const transcriptWords = wordCount(evidence.transcript);
  const evidenceWordCount = Math.max(answerWords, transcriptWords);
  const score = Number.isFinite(Number(evidence.score.final_score))
    ? Math.round(Number(evidence.score.final_score))
    : null;
  const maxFraud = evidence.answers.reduce((max, row) => Math.max(max, row.fraudScore), 0);
  const decision = normalizeDecision(evidence.score.decision ?? evidence.score.hire_recommendation, score);
  const risk = normalizeRisk(evidence.score.risk_level, maxFraud);
  const highlights = [...evidence.answers]
    .sort((left, right) => wordCount(right.answer) - wordCount(left.answer))
    .slice(0, 6)
    .map((row) => `Q${row.order} (${clipWords(row.question, 10)}): ${clipWords(row.answer, 38)}`);

  return [
    `VERIS summary refreshed from the richest available transcript and answer evidence. It covers ${evidence.answers.length} substantive answer(s) and about ${evidenceWordCount} words of candidate evidence. Final score: ${score === null ? "not scored" : `${score}/100`}. Decision: ${decision}. Risk level: ${risk}.`,
    risk === "HIGH"
      ? "High-risk authenticity or behavioral signals require recruiter review."
      : risk === "MEDIUM"
        ? "Some authenticity or behavioral signals should be reviewed alongside the transcript."
        : "No major authenticity risk was isolated from the available evidence.",
    highlights.length
      ? `Candidate evidence highlights: ${highlights.join(" | ")}.`
      : "No substantive candidate answer highlights were available; review the recording transcript directly.",
    transcriptWords > answerWords + 25
      ? `Additional recording context: ${clipWords(evidence.transcript, 80)}`
      : null,
  ].filter(Boolean).join("\n\n");
}

async function repairTarget(client, target, dryRun) {
  const evidence = await fetchEvidence(client, target.attempt_id);
  const summary = buildSummary(evidence);
  const score = Number.isFinite(Number(evidence.score.final_score))
    ? Number(evidence.score.final_score)
    : null;
  const decision = normalizeDecision(evidence.score.decision ?? evidence.score.hire_recommendation, score);

  if (!dryRun) {
    await client.query(
      `
        insert into public.interview_evaluations (
          attempt_id, final_score, decision, ai_summary, created_at, is_locked
        )
        values ($1::uuid, $2::numeric, $3::text, $4::text, now(), true)
        on conflict (attempt_id) do update
        set final_score = coalesce(excluded.final_score, public.interview_evaluations.final_score),
            decision = excluded.decision,
            ai_summary = excluded.ai_summary,
            created_at = excluded.created_at,
            is_locked = true
      `,
      [target.attempt_id, score, decision, summary]
    );
  }

  return {
    attemptId: target.attempt_id,
    candidate: target.candidate_name,
    answerCount: evidence.answers.length,
    transcriptWords: wordCount(evidence.transcript),
    summaryLength: summary.length,
    dryRun,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const client = new Client({
    connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  });

  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    throw new Error("Missing DATABASE_URL or POSTGRES_URL");
  }

  await client.connect();
  const targets = await fetchTargets(client, args);
  const results = [];

  for (const target of targets) {
    const result = await repairTarget(client, target, !args.apply);
    results.push(result);
    console.log(JSON.stringify({ event: "summary.repair", ...result }));
  }

  await client.end();
  console.log(JSON.stringify({ apply: args.apply, repaired: results.length, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
