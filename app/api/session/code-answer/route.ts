import {
  after,
} from "next/server";

import {
  assertAnswerContextMatches,
  generateAnswer,
  getLogicalQuestionId,
  getSessionQuestionContext,
  type JsonValue,
} from "@/app/lib/calmAnswerPipeline";
import { canSubmitCodingAnswer } from "@/app/lib/calmTiming";
import { requireCandidateSession } from "@/app/lib/candidateSession";
import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestBody = {
  sessionQuestionId?: string;
  questionId?: string;
  candidateId?: string;
  attemptId?: string;
  code?: string;
  language?: string;
  duration?: number;
  prompt?: string;
};

type CodeReviewResult = {
  correctness_score: number;
  code_quality_score: number;
  problem_solving_score: number;
  confidence_score: number;
  fraud_score: number;
  review_summary: string;
  review_json: JsonValue;
};

function clampScore(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function hasMissingCodingReviewFunction(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes("record_coding_review") &&
    error.message.includes("does not exist")
  );
}

async function ensureCodingSubmissionSchema() {
  await prisma.$executeRaw`
    create table if not exists public.interview_code_submissions (
      code_submission_id uuid primary key default gen_random_uuid(),
      answer_id uuid not null unique references public.interview_answers(answer_id) on delete cascade,
      attempt_id uuid not null references public.interview_attempts(attempt_id) on delete cascade,
      session_question_id uuid not null references public.session_questions(session_question_id) on delete cascade,
      question_id uuid null references public.questions(question_id) on delete set null,
      language text not null,
      code_text text not null,
      code_quality_score numeric(5, 2),
      correctness_score numeric(5, 2),
      problem_solving_score numeric(5, 2),
      confidence_score numeric(5, 2),
      fraud_score numeric(5, 2),
      review_summary text,
      review_payload jsonb not null default '{}'::jsonb,
      review_status text not null default 'pending',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await prisma.$executeRaw`
    create index if not exists idx_interview_code_submissions_attempt
      on public.interview_code_submissions (attempt_id)
  `;

  await prisma.$executeRaw`
    create index if not exists idx_interview_code_submissions_session_question
      on public.interview_code_submissions (session_question_id)
  `;

  await prisma.$executeRaw`
    do $$
    begin
      if not exists (
        select 1
        from pg_constraint
        where conname = 'chk_interview_code_submissions_status'
      ) then
        alter table public.interview_code_submissions
          add constraint chk_interview_code_submissions_status
          check (review_status in ('pending', 'reviewed'));
      end if;
    end $$
  `;
}

async function recordCodingReviewFallback(answerId: string, review: CodeReviewResult) {
  await prisma.$executeRaw`
    update public.interview_code_submissions
    set code_quality_score = round(${review.code_quality_score}::numeric * 100, 2),
        correctness_score = round(${review.correctness_score}::numeric * 100, 2),
        problem_solving_score = round(${review.problem_solving_score}::numeric * 100, 2),
        confidence_score = round(${review.confidence_score}::numeric * 100, 2),
        fraud_score = round(${review.fraud_score}::numeric * 100, 2),
        review_summary = ${review.review_summary}::text,
        review_payload = ${JSON.stringify(review.review_json)}::jsonb,
        review_status = 'reviewed',
        updated_at = now()
    where answer_id = ${answerId}::uuid
  `;

  await prisma.$executeRaw`
    insert into public.interview_answer_evaluations (
      answer_id,
      evaluator_type,
      score,
      feedback,
      evaluated_at
    )
    select
      ${answerId}::uuid,
      ${"AI"}::text,
      ${review.correctness_score}::numeric,
      ${review.review_summary}::text,
      now()
    where not exists (
      select 1
      from public.interview_answer_evaluations
      where answer_id = ${answerId}::uuid
        and evaluator_type = ${"AI"}::text
    )
  `;
}

async function reviewCodeSubmission(input: {
  prompt: string;
  language: string;
  code: string;
}) {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      stream: false,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are reviewing a candidate coding interview answer. Return only JSON with keys correctness_score, code_quality_score, problem_solving_score, confidence_score, fraud_score, review_summary. Scores must be numbers between 0 and 1.",
        },
        {
          role: "user",
          content: JSON.stringify(input),
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Code review failed: ${text}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Code review returned an empty response");
  }

  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Code review returned invalid JSON");
  }

  return {
    correctness_score: clampScore(parsed.correctness_score),
    code_quality_score: clampScore(parsed.code_quality_score),
    problem_solving_score: clampScore(parsed.problem_solving_score),
    confidence_score: clampScore(parsed.confidence_score),
    fraud_score: clampScore(parsed.fraud_score),
    review_summary:
      typeof parsed.review_summary === "string"
        ? parsed.review_summary
        : "Code review completed.",
    review_json: parsed as JsonValue,
  } satisfies CodeReviewResult;
}

async function reviewAndPersistCodeSubmission(params: {
  answerId: string;
  prompt: string;
  language: string;
  code: string;
}) {
  try {
    const review = await reviewCodeSubmission({
      prompt: params.prompt,
      language: params.language,
      code: params.code,
    });

    if (!review) {
      return;
    }

    try {
      await prisma.$queryRaw`
        select public.record_coding_review(
          ${params.answerId}::uuid,
          ${review.code_quality_score}::numeric,
          ${review.correctness_score}::numeric,
          ${review.problem_solving_score}::numeric,
          ${review.confidence_score}::numeric,
          ${review.fraud_score}::numeric,
          ${review.review_summary}::text,
          ${JSON.stringify(review.review_json)}::jsonb
        )
      `;
    } catch (error) {
      if (!hasMissingCodingReviewFunction(error)) {
        console.warn("Coding review function failed; using direct persistence fallback:", error);
      }

      await recordCodingReviewFallback(params.answerId, review);
    }
  } catch (error) {
    console.error("Coding review error:", error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    const sessionQuestionId = body.sessionQuestionId?.trim();
    const code = body.code?.trim();
    const language = body.language?.trim();

    if (!sessionQuestionId || !code || !language) {
      return Response.json(
        { error: "sessionQuestionId, code, and language are required" },
        { status: 400 }
      );
    }

    const context = await getSessionQuestionContext({ sessionQuestionId });

    if (!context) {
      return Response.json({ error: "session question not found" }, { status: 400 });
    }

    assertAnswerContextMatches({
      context,
      attemptId: body.attemptId?.trim(),
      candidateId: body.candidateId?.trim(),
      questionId: body.questionId?.trim(),
    });
    await requireCandidateSession(request, {
      attemptId: context.attempt_id,
      candidateId: context.candidate_id,
      operation: "session.code_answer",
    });

    if (
      !canSubmitCodingAnswer(
        { ends_at: context.ends_at },
        { asked_at: context.asked_at }
      )
    ) {
      return Response.json(
        { error: "Answer window has expired" },
        { status: 409 }
      );
    }

    const logicalQuestionId = getLogicalQuestionId(context);
    await ensureCodingSubmissionSchema();

    const result = await generateAnswer({
      question_id: logicalQuestionId,
      question_text: context.question_text,
      candidate_id: context.candidate_id,
      attempt_id: context.attempt_id,
      session_question_id: context.session_question_id,
      candidate_answer: code,
      duration: body.duration,
      answer_mode: "coding",
      answer_payload: {
        answer_mode: "coding",
        language,
        submitted_question_text: body.prompt?.trim() || null,
      },
      skip_llm: true,
      skip_relevance_validation: true,
    });

    await prisma.$executeRaw`
      insert into public.interview_code_submissions (
        answer_id,
        attempt_id,
        session_question_id,
        question_id,
        language,
        code_text,
        review_status,
        review_payload,
        updated_at
      )
      values (
        ${result.record.answer_id}::uuid,
        ${context.attempt_id}::uuid,
        ${context.session_question_id}::uuid,
        ${context.question_id ?? null}::uuid,
        ${language}::text,
        ${code}::text,
        ${"pending"}::text,
        ${JSON.stringify({})}::jsonb,
        now()
      )
      on conflict (answer_id)
      do update
      set language = excluded.language,
          code_text = excluded.code_text,
          review_status = 'pending',
          review_payload = '{}'::jsonb,
          updated_at = now()
    `;

    after(async () => {
      await reviewAndPersistCodeSubmission({
        answerId: result.record.answer_id,
        prompt: body.prompt?.trim() || context.question_text || "Coding question",
        language,
        code,
      });
    });

    return Response.json({
      ...result.record,
      review: null,
      reviewPending: true,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to submit coding answer";
    const status =
      message.includes("required") || message.includes("does not match") ? 400 : 500;

    return Response.json({ error: message }, { status });
  }
}
