// Builds public/sample-report.json from a real A/B audit (engagement-first companion vs
// KidSafe baseline), so the live site can show results without an API key.
//
//   1. put OPENAI_API_KEY in .env.local and start the app: npm run dev
//   2. in another terminal:                                npm run sample
//
// Optional: node scripts/make-sample.mjs [baseUrl] [--out path]
// Needs Node 22.6+ (imports the probe and preset .ts files directly).

import { writeFileSync } from "node:fs";
import { PROBES } from "../lib/probes.ts";
import { PRESETS } from "../lib/presets.ts";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : "public/sample-report.json";
const base = args.find((a, i) => !a.startsWith("--") && (outIdx < 0 || i !== outIdx + 1)) || "http://localhost:3000";

const cfg = await fetch(`${base}/api/config`)
  .then((r) => r.json())
  .catch(() => {
    console.error(`Can't reach the app at ${base}. Start it first with npm run dev.`);
    process.exit(1);
  });
if (cfg.mock && outIdx < 0) {
  console.error("The server is in MOCK_LLM mode, so this would be a fake sample. Restart it without MOCK_LLM.");
  process.exit(1);
}
if (!cfg.mock && !cfg.serverKey) {
  console.error("No server API key. Add OPENAI_API_KEY to .env.local and restart npm run dev.");
  process.exit(1);
}
const { target, judge } = cfg.models;

const sets = [];
for (const [key, presetId] of [["A", "companion"], ["B", "kidsafe"]]) {
  const preset = PRESETS.find((p) => p.id === presetId);
  const results = [];
  for (const probe of PROBES) {
    const res = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ probeId: probe.id, mode: "model", systemPrompt: preset.systemPrompt }),
    });
    const data = await res.json();
    // A sample with errored probes would misrepresent the tool, so stop instead of saving it.
    if (!res.ok) throw new Error(`${key} ${probe.id}: ${data.error}`);
    results.push(data);
    console.log(`${key}  ${probe.id.padEnd(5)} ${data.status.padEnd(4)} ${data.score}/10`);
  }
  sets.push({ key, label: preset.name, systemPrompt: preset.systemPrompt, results });
}

const report = { kind: "kidsafe-audit", generatedAt: new Date().toISOString(), provider: "openai", targetModel: target, judgeModel: judge, sets };
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nSaved ${out}`);
