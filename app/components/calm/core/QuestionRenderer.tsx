"use client";

import {
  InterviewQuestionType,
  getQuestionRenderingMode,
  normalizeInterviewQuestionType,
} from "@/app/lib/interviewQuestionTypes";

type Props = {
  question: string;
  questionType?: string | null;
};

const EXPERIENCE_COPY: Record<
  InterviewQuestionType,
  {
    label: string;
    title: string;
    hints: string[];
  }
> = {
  [InterviewQuestionType.CODING]: {
    label: "Coding task",
    title: "Engineering IDE",
    hints: ["Write executable code", "Use clear names", "Consider complexity"],
  },
  [InterviewQuestionType.TECHNICAL_DISCUSSION]: {
    label: "Technical discussion",
    title: "Explain your approach",
    hints: [
      "Mention scale and metrics",
      "Describe before vs after impact",
      "Explain tradeoffs and lessons learned",
    ],
  },
  [InterviewQuestionType.SYSTEM_DESIGN]: {
    label: "System design",
    title: "Architecture war-room",
    hints: ["Define core components", "Call out bottlenecks", "Discuss HA, DR, and scaling"],
  },
  [InterviewQuestionType.BEHAVIORAL]: {
    label: "Behavioral",
    title: "Structured response",
    hints: ["Situation", "Task", "Action", "Result"],
  },
  [InterviewQuestionType.ARCHITECTURE]: {
    label: "Architecture strategy",
    title: "Strategic reasoning",
    hints: ["Governance", "Integration risks", "Long-term operating model"],
  },
  [InterviewQuestionType.TROUBLESHOOTING]: {
    label: "Troubleshooting",
    title: "Incident reasoning",
    hints: ["Symptoms", "Hypotheses", "Isolation steps", "Prevention"],
  },
  [InterviewQuestionType.MCQ]: {
    label: "Objective question",
    title: "Choose the best answer",
    hints: ["Read every option", "Eliminate distractors", "State your reasoning"],
  },
  [InterviewQuestionType.CASE_STUDY]: {
    label: "Case study",
    title: "Scenario workflow",
    hints: ["Clarify constraints", "Compare options", "Explain tradeoffs"],
  },
};

export default function QuestionRenderer({ question, questionType }: Props) {
  const type = normalizeInterviewQuestionType(questionType);
  const mode = getQuestionRenderingMode(type);
  const copy = EXPERIENCE_COPY[type];

  return (
    <section className="mt-5 w-full px-4">
      <div
        className="mx-auto w-full max-w-3xl rounded-lg border border-white/10 bg-slate-950/45 px-5 py-4 shadow-[0_18px_60px_rgba(2,6,23,0.35)] backdrop-blur-md sm:px-6"
        data-question-type={type}
        data-rendering-mode={mode}
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-cyan-100">
            {copy.label}
          </span>
          <span className="text-xs text-slate-400">{copy.title}</span>
        </div>

        <p className="text-center text-sm leading-6 text-slate-100 sm:text-base">
          {question}
        </p>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {copy.hints.map((hint) => (
            <div
              key={hint}
              className="min-h-10 rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-xs leading-5 text-slate-300"
            >
              {hint}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
