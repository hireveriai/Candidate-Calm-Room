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

type RouteContext = {
  params: Promise<{
    attemptId: string;
  }>;
};

type InterviewSignalRecord = {
  signal_id: string;
  type: string;
  value: JsonValue;
  created_at: Date | null;
};

type BehavioralRow = {
  session_question_id: string;
  question_text: string | null;
  answer_text: string | null;
  answer_payload: JsonValue | null;
  clarity_score: string | number | null;
  depth_score: string | number | null;
  confidence_score: string | number | null;
  fraud_score: string | number | null;
  skill_score: string | number | null;
  reasoning: string | null;
  answered_at: Date | null;
};

type FocusMetricsValue = {
  focusRatio?: number;
  lookAwayEvents?: number;
  maxLookAwayDuration?: number;
  totalAnswerTime?: number;
  assessment?: string;
  sessionQuestionId?: string;
};

type BehavioralInsightResponse = {
  summary: string;
  strengths: string[];
  risks: string[];
  behavioral_score: number;
  confidence: number;
  metrics: {
    answers_evaluated: number;
    average_focus_ratio: number;
    tab_switches: number;
    multi_face_events: number;
    long_gaze_away_events: number;
    attention_loss_events: number;
    average_clarity_score: number;
    average_depth_score: number;
    average_confidence_score: number;
    average_fraud_score: number;
  };
};

function asNumber(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function asObject(value: JsonValue | null | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, JsonValue>;
}

function asFocusMetrics(value: JsonValue | null | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as FocusMetricsValue;
}

function average(values: number[]) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function extractAnswerTranscript(row: BehavioralRow) {
  const payload = asObject(row.answer_payload);
  const cleanedTranscript = normalizeText(
    typeof payload?.cleaned_transcript === "string"
      ? payload.cleaned_transcript
      : null
  );

  if (cleanedTranscript) {
    return cleanedTranscript;
  }

  return normalizeText(row.answer_text);
}

function collectTranscriptSummary(rows: BehavioralRow[]) {
  return rows
    .map((row) => extractAnswerTranscript(row))
    .filter(Boolean)
    .slice(0, 4)
    .map((text) => text.slice(0, 220));
}

function buildFallbackInsights(input: {
  answerCount: number;
  avgFocusRatio: number;
  tabSwitchCount: number;
  multiFaceCount: number;
  longGazeCount: number;
  attentionLossCount: number;
  avgClarity: number;
  avgDepth: number;
  avgConfidence: number;
  avgFraud: number;
}) {
  const strengths: string[] = [];
  const risks: string[] = [];

  if (input.avgClarity >= 0.68) {
    strengths.push(
      `Communication was generally clear with an average clarity score of ${round(
        input.avgClarity * 100
      )}.`
    );
  }

  if (input.avgDepth >= 0.68) {
    strengths.push(
      `Responses showed good depth with an average depth score of ${round(
        input.avgDepth * 100
      )}.`
    );
  }

  if (input.avgConfidence >= 0.68) {
    strengths.push(
      `The candidate presented answers with steady confidence at an average score of ${round(
        input.avgConfidence * 100
      )}.`
    );
  }

  if (input.avgFocusRatio >= 0.8 && input.tabSwitchCount === 0 && input.multiFaceCount === 0) {
    strengths.push(
      `Attention was steady throughout the attempt with an average focus ratio of ${round(
        input.avgFocusRatio * 100
      )}.`
    );
  }

  if (input.avgFocusRatio < 0.6) {
    risks.push(
      `Attention was inconsistent, with an average focus ratio of ${round(
        input.avgFocusRatio * 100
      )}.`
    );
  }

  if (input.attentionLossCount > 0) {
    risks.push(
      `Attention-loss events were observed ${input.attentionLossCount} time(s) during the interview.`
    );
  }

  if (input.longGazeCount > 0) {
    risks.push(
      `Extended look-away behavior was detected ${input.longGazeCount} time(s).`
    );
  }

  if (input.tabSwitchCount > 0) {
    risks.push(`Tab switching was detected ${input.tabSwitchCount} time(s).`);
  }

  if (input.multiFaceCount > 0) {
    risks.push(
      `Multiple-face events were detected ${input.multiFaceCount} time(s), which raises authenticity concerns.`
    );
  }

  if (input.avgFraud >= 0.55) {
    risks.push(
      `Behavioral and answer-level risk indicators were elevated with an average fraud score of ${round(
        input.avgFraud * 100
      )}.`
    );
  }

  const communicationScore = average([
    input.avgClarity,
    input.avgDepth,
    input.avgConfidence,
  ]);
  const attentionScore = clamp(
    (input.avgFocusRatio * 0.7) +
      Math.max(
        0,
        0.3 -
          (input.tabSwitchCount * 0.08) -
          (input.multiFaceCount * 0.12) -
          (input.longGazeCount * 0.06) -
          (input.attentionLossCount * 0.02)
      ),
    0,
    1
  );
  const behavioralScore = round(
    clamp(
      ((communicationScore * 0.5) + (attentionScore * 0.3) + ((1 - input.avgFraud) * 0.2)) *
        100,
      0,
      100
    )
  );
  const confidence = round(
    clamp(
      ((input.answerCount >= 3 ? 0.45 : 0.25) +
        (input.answerCount >= 6 ? 0.15 : 0) +
        (1 - Math.min(input.avgFraud, 0.6)) * 0.2 +
        Math.min(input.avgFocusRatio, 1) * 0.2) *
        100,
      0,
      100
    )
  );

  const summaryParts = [
    `The candidate showed ${behavioralScore >= 70 ? "generally stable" : behavioralScore >= 50 ? "mixed" : "concerning"} behavioral patterns across ${input.answerCount} evaluated response(s).`,
    `Average clarity, depth, and confidence scores were ${round(input.avgClarity * 100)}, ${round(
      input.avgDepth * 100
    )}, and ${round(input.avgConfidence * 100)} respectively.`,
    `Average focus ratio was ${round(input.avgFocusRatio * 100)}, while the average fraud score was ${round(
      input.avgFraud * 100
    )}.`,
  ];

  return {
    summary: summaryParts.join(" "),
    strengths: strengths.slice(0, 4),
    risks: risks.slice(0, 4),
    behavioral_score: behavioralScore,
    confidence,
  } satisfies Omit<BehavioralInsightResponse, "metrics">;
}

async function generateAiInsights(input: {
  transcriptSummary: string[];
  answerCount: number;
  avgFocusRatio: number;
  tabSwitchCount: number;
  multiFaceCount: number;
  longGazeCount: number;
  attentionLossCount: number;
  avgClarity: number;
  avgDepth: number;
  avgConfidence: number;
  avgFraud: number;
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
            "Generate recruiter-facing behavioral interview insights.",
            "Use only the provided metrics, transcript summary, and signal counts.",
            "Keep language professional, concise, and explainable.",
            "Every insight must be grounded in actual signals or scores.",
            "Avoid generic statements.",
            "Return only JSON with keys summary, strengths, risks, behavioral_score, confidence.",
            "strengths and risks must be arrays of short strings.",
            "behavioral_score and confidence must be numbers between 0 and 100.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify(input, null, 2),
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Behavioral insights generation failed: ${text}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Behavioral insights generation returned an empty response");
  }

  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Behavioral insights generation returned invalid JSON");
  }

  return {
    summary:
      typeof parsed.summary === "string" ? parsed.summary : "Behavioral insight generation completed.",
    strengths: Array.isArray(parsed.strengths)
      ? parsed.strengths.filter((item): item is string => typeof item === "string").slice(0, 5)
      : [],
    risks: Array.isArray(parsed.risks)
      ? parsed.risks.filter((item): item is string => typeof item === "string").slice(0, 5)
      : [],
    behavioral_score: round(clamp(asNumber(parsed.behavioral_score), 0, 100)),
    confidence: round(clamp(asNumber(parsed.confidence), 0, 100)),
  } satisfies Omit<BehavioralInsightResponse, "metrics">;
}

export async function GET(_: Request, context: RouteContext) {
  try {
    const { attemptId } = await context.params;

    if (!attemptId) {
      return Response.json({ error: "attemptId is required" }, { status: 400 });
    }

    const [rows, signals]: [BehavioralRow[], InterviewSignalRecord[]] = await Promise.all([
      prisma.$queryRaw<BehavioralRow[]>`
        select
          sq.session_question_id,
          sq.content as question_text,
          ia.answer_text,
          ia.answer_payload,
          iae.clarity_score,
          iae.depth_score,
          iae.confidence_score,
          iae.fraud_score,
          iae.skill_score,
          iae.feedback as reasoning,
          ia.answered_at
        from public.session_questions sq
        left join public.interview_answers ia
          on ia.session_question_id = sq.session_question_id
        left join public.interview_answer_evaluations iae
          on iae.answer_id = ia.answer_id
         and iae.evaluator_type = 'AI'
        where sq.attempt_id = ${attemptId}::uuid
        order by sq.question_order asc nulls last, sq.asked_at asc nulls last
      `,
      prisma.$queryRaw<InterviewSignalRecord[]>`
        select signal_id, type, value, created_at
        from public.interview_signals
        where attempt_id = ${attemptId}::uuid
        order by created_at asc
      `,
    ]);

    const evaluatedRows = rows.filter(
      (row: BehavioralRow) =>
        normalizeText(extractAnswerTranscript(row)).length > 0 ||
        row.clarity_score !== null ||
        row.depth_score !== null ||
        row.confidence_score !== null
    );

    const focusSignals = signals
      .filter((signal: InterviewSignalRecord) => signal.type === "focus_metrics")
      .map((signal: InterviewSignalRecord) => asFocusMetrics(signal.value))
      .filter(
        (value: FocusMetricsValue | null): value is FocusMetricsValue => value !== null
      );

    const avgFocusRatio = average(
      focusSignals
        .map((value: FocusMetricsValue) => value.focusRatio)
        .filter((value: number | undefined): value is number => typeof value === "number")
    );

    const counts = {
      tab_switch: signals.filter((signal: InterviewSignalRecord) => signal.type === "tab_switch").length,
      multi_face: signals.filter((signal: InterviewSignalRecord) => signal.type === "multi_face").length,
      long_gaze_away: signals.filter((signal: InterviewSignalRecord) => signal.type === "long_gaze_away").length,
      attention_loss: signals.filter((signal: InterviewSignalRecord) => signal.type === "attention_loss").length,
    };

    const avgClarity = average(
      evaluatedRows.map((row: BehavioralRow) => asNumber(row.clarity_score))
    );
    const avgDepth = average(
      evaluatedRows.map((row: BehavioralRow) => asNumber(row.depth_score))
    );
    const avgConfidence = average(
      evaluatedRows.map((row: BehavioralRow) => asNumber(row.confidence_score))
    );
    const avgFraud = average(
      evaluatedRows.map((row: BehavioralRow) => asNumber(row.fraud_score))
    );

    const transcriptSummary = collectTranscriptSummary(evaluatedRows);

    const aiInsights =
      (await generateAiInsights({
        transcriptSummary,
        answerCount: evaluatedRows.length,
        avgFocusRatio,
        tabSwitchCount: counts.tab_switch,
        multiFaceCount: counts.multi_face,
        longGazeCount: counts.long_gaze_away,
        attentionLossCount: counts.attention_loss,
        avgClarity,
        avgDepth,
        avgConfidence,
        avgFraud,
      }).catch((error) => {
        console.error("Behavioral insights AI error:", error);
        return null;
      })) ??
      buildFallbackInsights({
        answerCount: evaluatedRows.length,
        avgFocusRatio,
        tabSwitchCount: counts.tab_switch,
        multiFaceCount: counts.multi_face,
        longGazeCount: counts.long_gaze_away,
        attentionLossCount: counts.attention_loss,
        avgClarity,
        avgDepth,
        avgConfidence,
        avgFraud,
      });

    return Response.json({
      ...aiInsights,
      metrics: {
        answers_evaluated: evaluatedRows.length,
        average_focus_ratio: round(avgFocusRatio * 100),
        tab_switches: counts.tab_switch,
        multi_face_events: counts.multi_face,
        long_gaze_away_events: counts.long_gaze_away,
        attention_loss_events: counts.attention_loss,
        average_clarity_score: round(avgClarity * 100),
        average_depth_score: round(avgDepth * 100),
        average_confidence_score: round(avgConfidence * 100),
        average_fraud_score: round(avgFraud * 100),
      },
    } satisfies BehavioralInsightResponse);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to generate behavioral insights";

    return Response.json({ error: message }, { status: 500 });
  }
}
