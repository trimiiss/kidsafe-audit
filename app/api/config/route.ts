import { NextResponse } from "next/server";
import { DEFAULT_MODELS, isMock } from "@/lib/llm";

export const dynamic = "force-dynamic";

// Tells the UI whether the server has an OpenAI key (never returns the key itself).
export function GET() {
  return NextResponse.json({
    mock: isMock(),
    serverKey: !!process.env.OPENAI_API_KEY,
    models: DEFAULT_MODELS,
  });
}
