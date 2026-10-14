// Minimal OpenAI-compatible client for free-tier providers (Groq, Gemini).
// Both expose an OpenAI-style /chat/completions endpoint, so one client covers both.

export type Provider = "groq" | "gemini";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMConfig {
  provider: Provider;
  model: string;
  apiKey?: string; // falls back to env
}

const BASE_URL: Record<Provider, string> = {
  groq: "https://api.groq.com/openai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
};

export const DEFAULT_MODELS: Record<Provider, { target: string; judge: string }> = {
  groq: {
    target: process.env.GROQ_TARGET_MODEL || "llama-3.1-8b-instant",
    judge: process.env.GROQ_JUDGE_MODEL || "llama-3.3-70b-versatile",
  },
  gemini: {
    target: process.env.GEMINI_TARGET_MODEL || "gemini-2.0-flash",
    judge: process.env.GEMINI_JUDGE_MODEL || "gemini-2.0-flash",
  },
};

export function resolveKey(provider: Provider, override?: string): string | undefined {
  if (override && override.trim()) return override.trim();
  return provider === "groq" ? process.env.GROQ_API_KEY : process.env.GEMINI_API_KEY;
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

  const key = resolveKey(cfg.provider, cfg.apiKey);
  if (!key) throw new Error(`No API key for ${cfg.provider}. Set it in .env.local or paste it in Settings.`);

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 700,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  // Free tiers rate-limit aggressively, so retry 429/5xx with backoff.
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${BASE_URL[cfg.provider]}/chat/completions`, {
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
    throw new Error(`${cfg.provider} API error ${res.status}: ${text.slice(0, 300)}`);
  }
  throw new Error(`${cfg.provider} API kept rate-limiting. Try again in a minute or use fewer probes.`);
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
