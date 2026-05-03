import {
  assertAnswerContextMatches,
  generateAnswer,
  getLogicalQuestionId,
  getSessionQuestionContext,
  type JsonValue,
} from "@/app/lib/calmAnswerPipeline";
import { canSubmitAnswer } from "@/app/lib/calmTiming";
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

    if (
      !canSubmitAnswer(
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

    let review: CodeReviewResult | null = null;

    try {
      review = await reviewCodeSubmission({
        prompt: body.prompt?.trim() || context.question_text || "Coding question",
        language,
        code,
      });

      if (review) {
        await prisma.$queryRaw`
          select public.record_coding_review(
            ${result.record.answer_id}::uuid,
            ${review.code_quality_score}::numeric,
            ${review.correctness_score}::numeric,
            ${review.problem_solving_score}::numeric,
            ${review.confidence_score}::numeric,
            ${review.fraud_score}::numeric,
            ${review.review_summary}::text,
            ${JSON.stringify(review.review_json)}::jsonb
          )
        `;
      }
    } catch (error) {
      console.error("Coding review error:", error);
    }

    return Response.json({
      ...result.record,
      review,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to submit coding answer";
    const status =
      message.includes("required") || message.includes("does not match") ? 400 : 500;

    return Response.json({ error: message }, { status });
  }
}
