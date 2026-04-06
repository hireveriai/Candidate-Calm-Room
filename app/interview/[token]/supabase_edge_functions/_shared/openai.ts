import { getEnv } from "./common.ts";

type ChatMessage = {
  role: "system" | "user";
  content: string;
};

export async function createJsonChatCompletion(
  messages: ChatMessage[],
  temperature = 0.2
): Promise<Record<string, unknown>> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getEnv("OPENAI_API_KEY")}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature,
      response_format: { type: "json_object" },
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed: ${errorText}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenAI returned empty content");
  }

  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error("Failed to parse OpenAI JSON response");
  }
}
