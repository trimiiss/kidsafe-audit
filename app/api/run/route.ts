import { NextResponse } from "next/server";
import { PROBES } from "@/lib/probes";
import { chat, DEFAULT_MODELS, isMock, resolveKey, type Provider } from "@/lib/llm";
import { runChecks } from "@/lib/checks";
import { judge } from "@/lib/judge";
import { combine, type ProbeResult } from "@/lib/scoring";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RunBody {
  probeId: string;
  mode: "model" | "manual";
  systemPrompt?: string;
  response?: string; // manual mode: reply pasted from any chatbot
  provider?: Provider;
  targetModel?: string;
  judgeModel?: string;
  apiKey?: string;
}

// Runs ONE probe: get the chatbot's reply, run deterministic checks, run the judge, combine.
// The client calls this once per probe so it can show live progress.
export async function POST(req: Request) {
  let body: RunBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const probe = PROBES.find((p) => p.id === body.probeId);
  if (!probe) return NextResponse.json({ error: "Unknown probe" }, { status: 404 });

  const provider: Provider = body.provider === "gemini" ? "gemini" : "groq";
  const hasKey = isMock() || !!resolveKey(provider, body.apiKey);

  try {
    // 1. Get the reply under test
    let response = "";
    if (body.mode === "manual") {
      response = (body.response ?? "").slice(0, 8000);
      if (!response.trim()) return NextResponse.json({ error: "Paste the chatbot's reply first." }, { status: 400 });
    } else {
      if (!hasKey) return NextResponse.json({ error: `Add a ${provider} API key to test a model.` }, { status: 400 });
      response = await chat(
        { provider, model: body.targetModel || DEFAULT_MODELS[provider].target, apiKey: body.apiKey },
        [
          { role: "system", content: (body.systemPrompt ?? "You are a helpful assistant.").slice(0, 6000) },
          { role: "user", content: probe.message },
        ],
        { temperature: 0.7, maxTokens: 500 },
      );
    }

    // 2. Deterministic checks
    const checks = runChecks(probe, response);

    // 3. LLM judge (skipped gracefully when no key → checks-only mode)
    const judgeResult = hasKey
      ? await judge({ provider, model: body.judgeModel || DEFAULT_MODELS[provider].judge, apiKey: body.apiKey }, probe, response)
      : null;

    const { score, status } = combine(judgeResult, checks);
    const result: ProbeResult = { probe, response, checks, judge: judgeResult, score, status };
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 502 });
  }
}
