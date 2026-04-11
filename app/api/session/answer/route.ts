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
  transcript?: string;
  duration?: number;
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

function normalizeTranscript(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

async function cleanTranscriptForReadability(transcript: string) {
  const normalized = normalizeTranscript(transcript);

  if (!normalized || !process.env.OPENAI_API_KEY) {
    return normalized;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: [
            "Clean the following interview transcript for readability.",
            "Rules:",
            "- Remove filler words such as 'um', 'uh', and 'like' only when they are conversational fillers",
            "- Fix grammar, punctuation, and sentence structure",
            "- Keep the original meaning exactly the same",
            "- Do not add new information",
            "- Do not remove important details",
            "- Do not change technical terms, tool names, product names, or domain-specific vocabulary",
            "- Do not summarize",
            "- Do not paraphrase beyond what is necessary for readability",
            "- Preserve all concrete facts, examples, numbers, timelines, and responsibilities",
            "Output requirements:",
            "- Return only the cleaned transcript",
            "- Keep it professional and natural",
            "- If the transcript is already clean, return it with minimal changes",
          ].join("\n"),
        },
        {
          role: "user",
          content: normalized,
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Transcript cleanup failed: ${text}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Transcript cleanup returned an empty response");
  }

  return normalizeTranscript(content);
}

function hasMissingFunctionError(error: unknown, functionName: string) {
  return (
    error instanceof Error &&
    error.message.includes("Raw query failed") &&
    error.message.includes(functionName) &&
    error.message.includes("does not exist")
  );
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  try {
    console.log("[session/answer] request:start");
    const body = (await request.json()) as RequestBody;
    const { sessionQuestionId, transcript, duration } = body;

    if (!sessionQuestionId || !transcript) {
      return Response.json(
        { error: "sessionQuestionId and transcript are required" },
        { status: 400 }
      );
    }

    let cleanedTranscript = normalizeTranscript(transcript);

    try {
      cleanedTranscript = await cleanTranscriptForReadability(transcript);
    } catch (error) {
      console.error("Transcript cleanup error:", error);
    }

    const insertStartedAt = Date.now();
    let answer: AnswerRecord | undefined;
    const answerPayload =
      duration === undefined
        ? ({
            original_transcript: normalizeTranscript(transcript),
            cleaned_transcript: cleanedTranscript,
          } satisfies JsonValue)
        : ({
            duration,
            original_transcript: normalizeTranscript(transcript),
            cleaned_transcript: cleanedTranscript,
          } satisfies JsonValue);

    try {
      const rows = await prisma.$queryRaw<AnswerRecord[]>`
        select *
        from public.submit_interview_answer(
          ${sessionQuestionId}::uuid,
          ${cleanedTranscript}::text,
          ${duration ?? null}::integer
        )
      `;
      answer = rows[0];
    } catch (error) {
      if (!hasMissingFunctionError(error, "public.submit_interview_answer")) {
        throw error;
      }

      const sessionQuestion = await prisma.session_questions.findUnique({
        where: {
          session_question_id: sessionQuestionId,
        },
        select: {
          session_question_id: true,
          attempt_id: true,
          question_id: true,
        },
      });

      if (!sessionQuestion) {
        return Response.json(
          { error: "session question not found" },
          { status: 400 }
        );
      }

      const existingAnswer = await prisma.interview_answers.findFirst({
        where: {
          session_question_id: sessionQuestionId,
        },
      });

      answer = existingAnswer
        ? ((await prisma.interview_answers.update({
            where: {
              answer_id: existingAnswer.answer_id,
            },
            data: {
              answer_text: cleanedTranscript,
              answer_payload: answerPayload,
              answered_at: new Date(),
            },
          })) as AnswerRecord)
        : ((await prisma.interview_answers.create({
            data: {
              attempt_id: sessionQuestion.attempt_id,
              question_id: sessionQuestion.question_id,
              session_question_id: sessionQuestion.session_question_id,
              answer_text: cleanedTranscript,
              answer_payload: answerPayload,
            },
          })) as AnswerRecord);
    }

    console.log(
      `[session/answer] db:submit ${Date.now() - insertStartedAt}ms total=${Date.now() - startedAt}ms`
    );

    if (!answer) {
      return Response.json(
        { error: "session question not found" },
        { status: 400 }
      );
    }

    return Response.json(answer);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create answer";

    console.log(`[session/answer] error after ${Date.now() - startedAt}ms: ${message}`);

    return Response.json({ error: message }, { status: 500 });
  }
}
