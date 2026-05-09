import type { EventType, TimelineEvent } from "@/app/hooks/useEventTimeline";
import {
  InterviewQuestionType,
  normalizeInterviewQuestionType,
} from "@/app/lib/interviewQuestionTypes";

export function calculateFraudScore(
  events: TimelineEvent[],
  options: {
    questionType?: InterviewQuestionType | string | null;
    questionTypeMismatchDetected?: boolean;
  } = {}
) {
  let score = 0;
  const questionType = normalizeInterviewQuestionType(options.questionType);
  const isCodingExperience = questionType === InterviewQuestionType.CODING;

  const weights: Record<EventType, number> = {
    tab_switch: 30,
    multi_face: 40,
    no_face: 15,
    attention_loss: 10,
    long_gaze_away: 20,
    coding_start: 0,
    coding_end: 0,
    coding_copy: isCodingExperience ? 25 : 5,
    coding_paste: isCodingExperience ? 25 : 5,
    war_room_action: 0,
  };

  events.forEach((e) => {
    score += weights[e.type] || 0;
  });

  if (options.questionTypeMismatchDetected) {
    score *= 0.45;
  }

  return Math.round(score);
}

export function classifyRisk(score: number) {
  if (score < 30) return "LOW";
  if (score < 70) return "MEDIUM";
  return "HIGH";
}
