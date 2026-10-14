import { NextResponse } from "next/server";
import { DEFAULT_MODELS, isMock } from "@/lib/llm";

export const dynamic = "force-dynamic";

// Tells the UI which providers have server-side keys (never returns the keys themselves).
export function GET() {
  return NextResponse.json({
    mock: isMock(),
    serverKeys: { groq: !!process.env.GROQ_API_KEY, gemini: !!process.env.GEMINI_API_KEY },
    models: DEFAULT_MODELS,
  });
}
