import OpenAI from "openai";

import { prisma } from "@/app/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RequestBody = {
  attemptId?: string;
  lastQuestion?: string;
  lastAnswer?: string;
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function generateNextQuestion(lastQuestion: string, lastAnswer: string) {
  const openAiStartedAt = Date.now();
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    max_tokens: 60,
    messages: [
      {
        role: "system",
        content: `You are an expert technical interviewer.
Ask one deep, specific follow-up question.
Avoid generic wording.
Keep it concise.`,
      },
      {
        role: "user",
        content: `Previous question: "${lastQuestion}"
Candidate answer: "${lastAnswer}"
Ask one follow-up question only.`,
      },
    ],
  });

  console.log(`[session/next-question] openai ${Date.now() - openAiStartedAt}ms`);

  return completion.choices[0]?.message?.content?.trim() || "Can you elaborate?";
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  try {
    console.log("[session/next-question] request:start");
    const body = (await request.json()) as RequestBody;
    const { attemptId, lastQuestion, lastAnswer } = body;

    if (!attemptId || !lastAnswer) {
      return Response.json(
        { error: "attemptId and lastAnswer are required" },
        { status: 400 }
      );
    }

    if (!process.env.OPENAI_API_KEY) {
      return Response.json(
        { error: "OPENAI_API_KEY is not configured" },
        { status: 500 }
      );
    }

    let effectiveLastQuestion = lastQuestion?.trim() || "";

    if (!effectiveLastQuestion) {
      const lookupStartedAt = Date.now();
      const latestSessionQuestion = await prisma.session_questions.findFirst({
        where: {
          attempt_id: attemptId,
        },
        orderBy: {
          asked_at: "desc",
        },
        select: {
          content: true,
        },
      });
      console.log(
        `[session/next-question] db:lookup ${Date.now() - lookupStartedAt}ms`
      );

      if (!latestSessionQuestion) {
        return Response.json(
          { error: "no session questions found for this attempt" },
          { status: 400 }
        );
      }

      effectiveLastQuestion = latestSessionQuestion.content;
    }

    const question = await generateNextQuestion(effectiveLastQuestion, lastAnswer);

    const createStartedAt = Date.now();
    const sessionQuestion = await prisma.session_questions.create({
      data: {
        attempt_id: attemptId,
        content: question,
        source: "ai",
      },
    });
    console.log(
      `[session/next-question] db:create ${Date.now() - createStartedAt}ms total=${Date.now() - startedAt}ms`
    );

    return Response.json({
      question,
      session_question_id: sessionQuestion.session_question_id,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create next question";

    console.log(
      `[session/next-question] error after ${Date.now() - startedAt}ms: ${message}`
    );

    return Response.json({ error: message }, { status: 500 });
  }
}
