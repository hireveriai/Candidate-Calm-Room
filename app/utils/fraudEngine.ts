import type { EventType, TimelineEvent } from "@/app/hooks/useEventTimeline";

export function calculateFraudScore(events: TimelineEvent[]) {
  let score = 0;

  const weights: Record<EventType, number> = {
    tab_switch: 30,
    multi_face: 40,
    no_face: 15,
    attention_loss: 10,
    long_gaze_away: 20,
    coding_start: 0,
    coding_end: 0,
    coding_copy: 25,
    coding_paste: 25,
  };

  events.forEach((e) => {
    score += weights[e.type] || 0;
  });

  return score;
}

export function classifyRisk(score: number) {
  if (score < 30) return "LOW";
  if (score < 70) return "MEDIUM";
  return "HIGH";
}
