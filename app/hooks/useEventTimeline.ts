"use client";

import { useState } from "react";

export type EventType =
  | "tab_switch"
  | "multi_face"
  | "no_face"
  | "attention_loss"
  | "long_gaze_away"
  | "coding_start"
  | "coding_end"
  | "coding_copy"
  | "coding_paste";

export type TimelineEvent = {
  type: EventType;
  timestamp: number;
  severity?: "low" | "medium" | "high";
  meta?: any;
};

export default function useEventTimeline() {
  const [events, setEvents] = useState<TimelineEvent[]>([]);

  const addEvent = (event: Omit<TimelineEvent, "timestamp">) => {
    const newEvent: TimelineEvent = {
      ...event,
      timestamp: Date.now(),
    };

    console.log("📍 EVENT:", newEvent);

    setEvents((prev) => [...prev, newEvent]);
  };

  return {
    events,
    addEvent,
  };
}
