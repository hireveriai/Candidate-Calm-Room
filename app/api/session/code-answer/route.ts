import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

type RequestBody = {
  sessionQuestionId?: string;
  code?: string;
  language?: string;
  duration?: number;
  prompt?: string;
};

type AnswerRecord = {
  answer_id: string;
  attempt_id: string;
  question_id: string | null;
  session_question_id: string | null;
  answer_text: string;
  answer_payload: JsonValue | null;
  answered_at: Date | null;
};

type QuestionContextRow = {
  content: string | null;
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
    const { sessionQuestionId, code, language, duration, prompt } = body;

    if (!sessionQuestionId || !code?.trim() || !language?.trim()) {
      return Response.json(
        { error: "sessionQuestionId, code, and language are required" },
        { status: 400 }
      );
    }

    const answerRows = await prisma.$queryRaw<AnswerRecord[]>`
      select *
      from public.submit_coding_answer(
        ${sessionQuestionId}::uuid,
        ${code.trim()}::text,
        ${language.trim()}::text,
        ${duration ?? null}::integer
      )
    `;

    const answer = answerRows[0];

    if (!answer) {
      return Response.json(
        { error: "Failed to save coding answer" },
        { status: 500 }
      );
    }

    let review: CodeReviewResult | null = null;

    try {
      const questionRows = await prisma.$queryRaw<QuestionContextRow[]>`
        select content
        from public.session_questions
        where session_question_id = ${sessionQuestionId}::uuid
        limit 1
      `;

      review = await reviewCodeSubmission({
        prompt: prompt?.trim() || questionRows[0]?.content || "Coding question",
        language: language.trim(),
        code: code.trim(),
      });

      if (review) {
        await prisma.$queryRaw`
          select public.record_coding_review(
            ${answer.answer_id}::uuid,
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
      ...answer,
      review,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to submit coding answer";

    return Response.json({ error: message }, { status: 500 });
  }
}
