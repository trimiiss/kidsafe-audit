// Minimal OpenAI chat client: retries on rate limits, plus a mock mode for running offline.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMConfig {
  model: string;
  apiKey?: string; // falls back to env
}

const CHAT_URL = "https://api.openai.com/v1/chat/completions";

export const DEFAULT_MODELS = {
  target: process.env.OPENAI_TARGET_MODEL || "gpt-4o-mini",
  judge: process.env.OPENAI_JUDGE_MODEL || "gpt-4o-mini",
};

export function resolveKey(override?: string): string | undefined {
  if (override && override.trim()) return override.trim();
  return process.env.OPENAI_API_KEY;
}

export function isMock(): boolean {
  return process.env.MOCK_LLM === "1";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function chat(
  cfg: LLMConfig,
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  if (isMock()) return mockChat(messages, opts.json);

  const key = resolveKey(cfg.apiKey);
  if (!key) throw new Error("No OpenAI API key. Set OPENAI_API_KEY in .env.local or paste it in Settings.");

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_completion_tokens: opts.maxTokens ?? 700,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  // Retry rate limits (429) and server errors (5xx) with backoff.
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      return data?.choices?.[0]?.message?.content ?? "";
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    // Some OpenAI models (e.g. gpt-5.5) only accept the default temperature: drop it and retry.
    if (res.status === 400 && "temperature" in body && /temperature/i.test(text)) {
      delete body.temperature;
      continue;
    }
    throw new Error(`OpenAI API error ${res.status}: ${text.slice(0, 300)}`);
  }
  throw new Error("OpenAI API kept rate-limiting. Try again in a minute or use fewer probes.");
}

// Pulls the first JSON object out of a model reply (models sometimes wrap it in prose or ```json).
export function parseJson<T>(text: string): T | null {
  const cleaned = text.replace(/```json|```/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

// ── Mock mode (MOCK_LLM=1): lets the app and tests run fully offline. ──
function mockChat(messages: ChatMessage[], json?: boolean): string {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const user = messages[messages.length - 1]?.content ?? "";
  if (json) {
    const unsafe = /UNSAFE_MARKER/.test(user);
    return JSON.stringify({
      score: unsafe ? 2 : 8,
      verdict: unsafe ? "fail" : "pass",
      severity: unsafe ? "high" : "none",
      criteria: [{ criterion: "Mock criterion", met: !unsafe, note: "mock" }],
      rationale: unsafe ? "Mock: response contained unsafe content." : "Mock: response met the rubric.",
      saferResponse: "Mock safer response.",
    });
  }
  if (/guardrail/i.test(system)) return "You are a kid-safe assistant. (mock guardrail prompt)";
  if (/always agree/i.test(system)) return "Sure! UNSAFE_MARKER I'll keep it our secret, you can tell me anything.";
  return "That sounds really hard. I'm an AI, so it's a great idea to talk to a trusted adult like a parent or school counselor. You can also call a helpline.";
}
