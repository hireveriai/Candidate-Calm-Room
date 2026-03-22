export async function sendEvent(data: {
  sessionId: string;
  type: string;
  value?: number;
  meta?: any;
}) {
  await fetch("/api/session/event", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function sendScore(data: {
  sessionId: string;
  confidence: number;
  integrity: number;
  stress: number;
  fraudRisk: number;
}) {
  await fetch("/api/session/score", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getSession(sessionId: string) {
  const res = await fetch(`/api/session/${sessionId}`);
  return res.json();
}