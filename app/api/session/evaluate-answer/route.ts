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

type BehaviorSignal = {
  type: string;
  severity?: "low" | "medium" | "high";
  meta?: JsonValue;
  timestamp?: number;
};

type FocusMetrics = {
  focusRatio?: number;
  lookAwayEvents?: number;
  maxLookAwayDuration?: number;
  totalAnswerTime?: number;
  assessment?: string;
};

type RequestBody = {
  answerId?: string;
  sessionQuestionId?: string;
  transcript?: string;
  rawTranscript?: string;
  focusMetrics?: FocusMetrics | null;
  behaviorSignals?: BehaviorSignal[];
};

type QuestionContextRow = {
  answer_id: string;
  attempt_id: string;
  question_text: string | null;
  source_type: string | null;
  skill_id: string | null;
  skill_name: string | null;
  job_title: string | null;
};

type EvaluationResult = {
  skill_score: number;
  clarity_score: number;
  depth_score: number;
  confidence_score: number;
  fraud_score: number;
  reasoning: string;
  evaluation_json: JsonValue;
};

function clamp01(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function deriveSkillType(
  sourceType: string | null | undefined,
  skillName: string | null | undefined
) {
  if (sourceType === "behavioral") {
    return "behavioral";
  }

  const normalizedSkill = normalizeText(skillName).toLowerCase();

  if (
    /\b(sql|database|postgres|postgresql|mysql|oracle|python|java|typescript|javascript|react|node|api|etl|performance|backup|recovery|debug|coding|programming)\b/i.test(
      normalizedSkill
    )
  ) {
    return "technical";
  }

  return "functional";
}

function calculateBehaviorFraudAdjustment(params: {
  behaviorSignals: BehaviorSignal[];
  focusMetrics: FocusMetrics | null | undefined;
}) {
  const counts = {
    multi_face: 0,
    tab_switch: 0,
    long_gaze_away: 0,
    attention_loss: 0,
    no_face: 0,
  };

  for (const signal of params.behaviorSignals) {
    if (signal.type in counts) {
      counts[signal.type as keyof typeof counts] += 1;
    }
  }

  let adjustment = 0;

  adjustment += Math.min(counts.multi_face * 0.18, 0.36);
  adjustment += Math.min(counts.tab_switch * 0.12, 0.36);
  adjustment += Math.min(counts.long_gaze_away * 0.15, 0.3);
  adjustment += Math.min(counts.attention_loss * 0.04, 0.16);
  adjustment += Math.min(counts.no_face * 0.05, 0.15);

  const focusRatio = params.focusMetrics?.focusRatio ?? 1;
  const maxLookAwayDuration = params.focusMetrics?.maxLookAwayDuration ?? 0;
  const lookAwayEvents = params.focusMetrics?.lookAwayEvents ?? 0;

  if (focusRatio < 0.4) {
    adjustment += 0.18;
  } else if (focusRatio < 0.6) {
    adjustment += 0.08;
  }

  if (maxLookAwayDuration >= 8) {
    adjustment += 0.12;
  } else if (maxLookAwayDuration >= 4) {
    adjustment += 0.06;
  }

  adjustment += Math.min(lookAwayEvents * 0.04, 0.12);

  return clamp01(adjustment);
}

function fallbackEvaluation(params: {
  transcript: string;
  skillName: string | null;
  focusMetrics: FocusMetrics | null | undefined;
  behaviorSignals: BehaviorSignal[];
}) {
  const wordCount = normalizeText(params.transcript).split(/\s+/).filter(Boolean).length;
  const hasMetrics = /\b\d+(\.\d+)?%?\b/.test(params.transcript);
  const hasTools = Boolean(
    params.skillName &&
      new RegExp(`\\b${params.skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
        params.transcript
      )
  );
  const fraudAdjustment = calculateBehaviorFraudAdjustment({
    behaviorSignals: params.behaviorSignals,
    focusMetrics: params.focusMetrics,
  });

  const clarity =
    wordCount >= 60 ? 0.72 : wordCount >= 35 ? 0.62 : wordCount >= 20 ? 0.5 : 0.34;
  const depth =
    hasMetrics || hasTools ? 0.68 : wordCount >= 45 ? 0.58 : wordCount >= 25 ? 0.46 : 0.3;
  const confidence = clamp01(
    (params.focusMetrics?.focusRatio ?? 0.8) * 0.7 + (wordCount >= 25 ? 0.15 : 0)
  );
  const skill = clamp01((clarity * 0.45) + (depth * 0.55));

  return {
    skill_score: skill,
    clarity_score: clarity,
    depth_score: depth,
    confidence_score: confidence,
    fraud_score: clamp01(0.12 + fraudAdjustment),
    reasoning:
      "Fallback evaluation used because AI scoring was unavailable. Scores were estimated from transcript length, specificity, and observed behavior signals.",
    evaluation_json: {
      mode: "fallback",
      word_count: wordCount,
      fraud_adjustment: fraudAdjustment,
    },
  } satisfies EvaluationResult;
}

async function evaluateWithAi(input: {
  jobRole: string | null;
  skillName: string | null;
  skillType: string;
  questionText: string | null;
  transcript: string;
  rawTranscript: string | null;
  focusMetrics: FocusMetrics | null | undefined;
  behaviorSignals: BehaviorSignal[];
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
          content: [
            "You are evaluating a spoken interview answer.",
            "Return only JSON with keys skill_score, clarity_score, depth_score, confidence_score, fraud_score, reasoning.",
            "All scores must be numbers between 0 and 1.",
            "Score using the transcript and signals together.",
            "Clarity should reflect communication structure and readability.",
            "Depth should reflect specificity, technical or functional detail, and authenticity.",
            "Confidence should reflect decisiveness, coherence, and delivery confidence, not arrogance.",
            "Fraud score should reflect inconsistency, suspicious behavior, and authenticity risk.",
            "Do not inflate scores when the answer is vague.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              job_role: input.jobRole ?? "",
              skill: input.skillName ?? "",
              skill_type: input.skillType,
              question: input.questionText ?? "",
              transcript: input.transcript,
              raw_transcript: input.rawTranscript ?? "",
              focus_metrics: input.focusMetrics ?? null,
              behavior_signals: input.behaviorSignals,
            },
            null,
            2
          ),
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Answer evaluation failed: ${text}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Answer evaluation returned an empty response");
  }

  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Answer evaluation returned invalid JSON");
  }

  return {
    skill_score: clamp01(parsed.skill_score),
    clarity_score: clamp01(parsed.clarity_score),
    depth_score: clamp01(parsed.depth_score),
    confidence_score: clamp01(parsed.confidence_score),
    fraud_score: clamp01(parsed.fraud_score),
    reasoning:
      typeof parsed.reasoning === "string"
        ? parsed.reasoning
        : "AI evaluation completed.",
    evaluation_json: parsed as JsonValue,
  } satisfies EvaluationResult;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    const {
      answerId,
      sessionQuestionId,
      transcript,
      rawTranscript,
      focusMetrics,
      behaviorSignals = [],
    } = body;

    if (!answerId || !sessionQuestionId || !transcript?.trim()) {
      return Response.json(
        { error: "answerId, sessionQuestionId, and transcript are required" },
        { status: 400 }
      );
    }

    const contextRows = await prisma.$queryRaw<QuestionContextRow[]>`
      select
        ia.answer_id,
        ia.attempt_id,
        sq.content as question_text,
        iq.source_type,
        coalesce(iq.target_skill_id, qsm.skill_id) as skill_id,
        sm.skill_name,
        jp.job_title
      from public.interview_answers ia
      join public.session_questions sq
        on sq.session_question_id = ia.session_question_id
      join public.interview_attempts iat
        on iat.attempt_id = ia.attempt_id
      left join public.interviews i
        on i.interview_id = iat.interview_id
      left join public.job_positions jp
        on jp.job_id = i.job_id
      left join public.interview_questions iq
        on iq.interview_id = iat.interview_id
       and iq.question_id = ia.question_id
      left join public.question_skill_map qsm
        on qsm.question_id = ia.question_id
      left join public.skill_master sm
        on sm.skill_id = coalesce(iq.target_skill_id, qsm.skill_id)
      where ia.answer_id = ${answerId}::uuid
        and ia.session_question_id = ${sessionQuestionId}::uuid
      limit 1
    `;

    const context = contextRows[0];

    if (!context) {
      return Response.json({ error: "Answer context not found" }, { status: 404 });
    }

    const skillType = deriveSkillType(context.source_type, context.skill_name);
    const normalizedTranscript = normalizeText(transcript);
    const normalizedRawTranscript = normalizeText(rawTranscript);

    let evaluation =
      (await evaluateWithAi({
        jobRole: context.job_title,
        skillName: context.skill_name,
        skillType,
        questionText: context.question_text,
        transcript: normalizedTranscript,
        rawTranscript: normalizedRawTranscript || null,
        focusMetrics,
        behaviorSignals,
      }).catch((error) => {
        console.error("Spoken answer AI evaluation error:", error);
        return null;
      })) ??
      fallbackEvaluation({
        transcript: normalizedTranscript,
        skillName: context.skill_name,
        focusMetrics,
        behaviorSignals,
      });

    const behaviorFraudAdjustment = calculateBehaviorFraudAdjustment({
      behaviorSignals,
      focusMetrics,
    });
    const adjustedFraudScore = clamp01(
      evaluation.fraud_score + behaviorFraudAdjustment
    );

    evaluation = {
      ...evaluation,
      fraud_score: adjustedFraudScore,
      evaluation_json: {
        ...(typeof evaluation.evaluation_json === "object" &&
        evaluation.evaluation_json &&
        !Array.isArray(evaluation.evaluation_json)
          ? evaluation.evaluation_json
          : {}),
        signal_adjustment: {
          behavior_fraud_adjustment: behaviorFraudAdjustment,
          behavior_signals: behaviorSignals,
          focus_metrics: focusMetrics ?? null,
        },
      },
    };

    await prisma.$queryRaw`
      select *
      from public.record_answer_evaluation(
        ${answerId}::uuid,
        ${evaluation.skill_score}::numeric,
        ${evaluation.clarity_score}::numeric,
        ${evaluation.depth_score}::numeric,
        ${evaluation.confidence_score}::numeric,
        ${evaluation.fraud_score}::numeric,
        ${evaluation.reasoning}::text,
        ${context.skill_id}::uuid,
        ${JSON.stringify(evaluation.evaluation_json)}::jsonb
      )
    `;

    return Response.json({
      answer_id: answerId,
      attempt_id: context.attempt_id,
      skill_id: context.skill_id,
      skill_name: context.skill_name,
      skill_type: skillType,
      ...evaluation,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to evaluate spoken answer";

    return Response.json({ error: message }, { status: 500 });
  }
}
