import { randomUUID } from "crypto";

import { prisma } from "@/app/lib/prisma";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export type AnswerStatus = "generating" | "completed" | "failed";

export type AnswerRecord = {
  answer_id: string;
  attempt_id: string;
  question_id: string | null;
  session_question_id: string | null;
  answer_text: string | null;
  answer_payload: JsonValue | null;
  answered_at: Date | null;
  status?: AnswerStatus | null;
};

type SessionQuestionContext = {
  session_question_id: string;
  attempt_id: string;
  question_id: string | null;
  question_text: string;
  asked_at: Date | null;
  candidate_id: string;
  ends_at: Date | null;
};

type GenerateAnswerInput = {
  question_id: string;
  question_text: string;
  candidate_id: string;
  attempt_id: string;
  session_question_id?: string;
  candidate_answer?: string;
  duration?: number;
  answer_mode?: "spoken" | "coding" | "generated";
  answer_payload?: JsonValue;
  skip_llm?: boolean;
  skip_relevance_validation?: boolean;
};

type GenerateAnswerResult = {
  answer: string;
  record: AnswerRecord;
};

type LlmResult = {
  text: string;
  payload: JsonValue;
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "why",
  "with",
  "you",
  "your",
]);

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function extractKeywords(question: string) {
  return question
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/i)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

export function validateAnswer(answer: string, question: string) {
  const normalizedAnswer = normalizeText(answer);

  if (normalizedAnswer.length < 20) {
    return false;
  }

  const answerLower = normalizedAnswer.toLowerCase();
  const keywords = extractKeywords(question);

  if (keywords.length === 0) {
    return true;
  }

  return keywords.some((word) => answerLower.includes(word));
}

function buildPrompt(input: GenerateAnswerInput) {
  const basePrompt = `
You are evaluating a candidate in an interview.

Question:
${input.question_text}

Instructions:
- Answer clearly and professionally
- Stay strictly relevant to the question
- Do not include unrelated content
`;

  const candidateAnswer = normalizeText(input.candidate_answer);

  if (!candidateAnswer) {
    return basePrompt;
  }

  return `
You are preparing a candidate's interview answer for final storage.

Question:
${input.question_text}

Candidate answer:
${candidateAnswer}

Instructions:
- Return only the final answer text
- Clean obvious transcription artifacts, repeated phrases, and filler words
- Preserve the candidate's meaning and concrete facts exactly
- Do not add facts, examples, skills, tools, or claims the candidate did not say
- Stay strictly relevant to the question
- Do not include unrelated content
`;
}

async function callLlm(input: GenerateAnswerInput): Promise<LlmResult | null> {
  if (input.skip_llm || !process.env.OPENAI_API_KEY) {
    return null;
  }

  const prompt = buildPrompt(input);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: input.candidate_answer ? 0.1 : 0.2,
      stream: false,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Answer generation failed: ${text}`);
  }

  const payload = await response.json();
  const text = normalizeText(payload?.choices?.[0]?.message?.content);

  if (!text) {
    throw new Error("Answer generation returned an empty response");
  }

  return {
    text,
    payload: {
      provider: "openai",
      model: payload?.model ?? "gpt-4o-mini",
      id: payload?.id ?? null,
      usage: payload?.usage ?? null,
      stream: false,
    },
  };
}

function mergePayloads(...payloads: Array<JsonValue | undefined>): JsonValue {
  const merged: Record<string, JsonValue> = {};

  for (const payload of payloads) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      continue;
    }

    Object.assign(merged, payload);
  }

  return merged;
}

function getPayloadObject(payload: JsonValue | null | undefined) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  return payload as Record<string, JsonValue>;
}

async function setAnswerStatus(params: {
  answerId: string;
  status: AnswerStatus;
  answerText: string | null;
  answerPayload: JsonValue | null;
}) {
  const rows = await prisma.$queryRaw<AnswerRecord[]>`
    update public.interview_answers
    set status = ${params.status}::text,
        answer_text = ${params.answerText}::text,
        answer_payload = ${
          params.answerPayload ? JSON.stringify(params.answerPayload) : null
        }::jsonb,
        answered_at = now()
    where answer_id = ${params.answerId}::uuid
    returning
      answer_id,
      attempt_id,
      question_id,
      session_question_id,
      answer_text,
      answer_payload,
      answered_at,
      status
  `;

  const answer = rows[0];

  if (!answer) {
    throw new Error("Answer status update failed");
  }

  return answer;
}

async function ensureGeneratingAnswer(input: GenerateAnswerInput) {
  const existingRows = await prisma.$queryRaw<AnswerRecord[]>`
    select
      answer_id,
      attempt_id,
      question_id,
      session_question_id,
      answer_text,
      answer_payload,
      answered_at,
      status
    from public.interview_answers
    where session_question_id = ${input.session_question_id ?? null}::uuid
    limit 1
  `;
  const existing = existingRows[0] ?? null;

  if (existing?.status === "completed" && normalizeText(existing.answer_text)) {
    const existingPayload = getPayloadObject(existing.answer_payload);
    const rawCandidateAnswer =
      typeof existingPayload.raw_candidate_answer === "string"
        ? existingPayload.raw_candidate_answer
        : "";

    if (
      input.candidate_answer &&
      (normalizeText(existing.answer_text) === normalizeText(input.candidate_answer) ||
        normalizeText(rawCandidateAnswer) === normalizeText(input.candidate_answer))
    ) {
      return {
        record: existing,
        alreadyCompleted: true,
      };
    }

    throw new Error("Answer has already been completed for this question");
  }

  if (existing?.answer_id) {
    const record = await setAnswerStatus({
      answerId: existing.answer_id,
      status: "generating",
      answerText: null,
      answerPayload: {
        answer_mode: input.answer_mode ?? "generated",
        status_started_at: new Date().toISOString(),
      },
    });

    return {
      record,
      alreadyCompleted: false,
    };
  }

  const answerId = randomUUID();
  const startingPayload = {
    answer_mode: input.answer_mode ?? "generated",
    status_started_at: new Date().toISOString(),
  } satisfies JsonValue;
  const createdRows = await prisma.$queryRaw<AnswerRecord[]>`
    insert into public.interview_answers (
      answer_id,
      attempt_id,
      question_id,
      session_question_id,
      answer_text,
      answer_payload,
      status
    )
    values (
      ${answerId}::uuid,
      ${input.attempt_id}::uuid,
      ${
        input.session_question_id === input.question_id ? null : input.question_id
      }::uuid,
      ${input.session_question_id ?? null}::uuid,
      ${null}::text,
      ${JSON.stringify(startingPayload)}::jsonb,
      ${"generating"}::text
    )
    returning
      answer_id,
      attempt_id,
      question_id,
      session_question_id,
      answer_text,
      answer_payload,
      answered_at,
      status
  `;
  const record = createdRows[0];

  if (!record) {
    throw new Error("Answer creation failed");
  }

  return {
    record,
    alreadyCompleted: false,
  };
}

export async function generateAnswer(
  input: GenerateAnswerInput
): Promise<GenerateAnswerResult> {
  const initialAnswer = await ensureGeneratingAnswer(input);

  if (initialAnswer.alreadyCompleted) {
    return {
      answer: normalizeText(initialAnswer.record.answer_text),
      record: initialAnswer.record,
    };
  }

  try {
    const llmResult = await callLlm(input);
    const answer = normalizeText(
      llmResult?.text ?? input.candidate_answer ?? ""
    );

    if (!answer || answer.length < 15) {
      throw new Error("Invalid or empty answer");
    }

    if (
      !input.skip_relevance_validation &&
      !validateAnswer(answer, input.question_text)
    ) {
      throw new Error("Answer failed relevance validation");
    }

    console.log({
      question_id: input.question_id,
      question_text: input.question_text,
      answer,
    });

    const answerPayload = mergePayloads(input.answer_payload, {
      answer_mode: input.answer_mode ?? "generated",
      candidate_id: input.candidate_id,
      question_id: input.question_id,
      session_question_id: input.session_question_id ?? null,
      duration: typeof input.duration === "number" ? input.duration : null,
      raw_candidate_answer: input.candidate_answer ?? null,
      llm: llmResult?.payload ?? null,
      validation: {
        relevant: input.skip_relevance_validation ? null : true,
        checked_at: new Date().toISOString(),
      },
    });

    const record = await setAnswerStatus({
      answerId: initialAnswer.record.answer_id,
      status: "completed",
      answerText: answer,
      answerPayload,
    });

    return {
      answer,
      record,
    };
  } catch (error) {
    await setAnswerStatus({
      answerId: initialAnswer.record.answer_id,
      status: "failed",
      answerText: null,
      answerPayload: mergePayloads(initialAnswer.record.answer_payload, {
        error: error instanceof Error ? error.message : "Unknown answer error",
        failed_at: new Date().toISOString(),
      }),
    });

    throw error;
  }
}

export async function getSessionQuestionContext(params: {
  sessionQuestionId: string;
}) {
  const rows = await prisma.$queryRaw<SessionQuestionContext[]>`
    select
      sq.session_question_id,
      sq.attempt_id,
      sq.question_id,
      sq.content as question_text,
      sq.asked_at,
      i.candidate_id,
      ia.ends_at
    from public.session_questions sq
    join public.interview_attempts ia
      on ia.attempt_id = sq.attempt_id
    join public.interviews i
      on i.interview_id = ia.interview_id
    where sq.session_question_id = ${params.sessionQuestionId}::uuid
    limit 1
  `;

  return rows[0] ?? null;
}

export function getLogicalQuestionId(context: SessionQuestionContext) {
  return context.question_id ?? context.session_question_id;
}

export function assertAnswerContextMatches(params: {
  context: SessionQuestionContext;
  attemptId?: string;
  candidateId?: string;
  questionId?: string;
}) {
  const logicalQuestionId = getLogicalQuestionId(params.context);

  if (params.attemptId && params.attemptId !== params.context.attempt_id) {
    throw new Error("attempt_id does not match session question");
  }

  if (params.candidateId && params.candidateId !== params.context.candidate_id) {
    throw new Error("candidate_id does not match attempt");
  }

  if (params.questionId && params.questionId !== logicalQuestionId) {
    throw new Error("question_id does not match session question");
  }

  if (!params.attemptId || !params.candidateId || !params.questionId) {
    throw new Error("question_id, attempt_id, and candidate_id are required");
  }
}
