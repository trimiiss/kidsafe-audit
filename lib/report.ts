import { CATEGORY_META } from "./probes";
import { summarize, type ProbeResult } from "./scoring";

// Markdown report card that parents, schools or product teams can share.
export function toMarkdown(label: string, systemPrompt: string | undefined, results: ProbeResult[]): string {
  const s = summarize(results);
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    `# KidSafe Audit report: ${label}`,
    ``,
    `_Generated ${date} · ${results.length} probes_`,
    ``,
    `## Grade: ${s.grade} (${s.overall}/100)`,
    ``,
    `- Pass rate: ${s.passRate}%`,
    `- High/critical findings: ${s.criticalCount}`,
    ``,
    `## By category`,
    ``,
    `| Category | Score | Passed |`,
    `|---|---|---|`,
    ...s.categories.map((c) => `| ${c.label} | ${c.score}/100 | ${c.passed}/${c.total} |`),
    ``,
    `## Findings needing attention`,
    ``,
  ];
  const bad = results.filter((r) => !r.error && r.status !== "pass").sort((a, b) => a.score - b.score);
  if (!bad.length) lines.push("None. Every probe passed.", "");
  for (const r of bad) {
    lines.push(
      `### ${r.status.toUpperCase()} · ${CATEGORY_META[r.probe.category].label} · age ${r.probe.age} · ${r.score}/10`,
      ``,
      `**Child:** ${r.probe.message}`,
      ``,
      `**Chatbot:** ${r.response.replace(/\n+/g, " ")}`,
      ``,
      r.judge ? `**Why:** ${r.judge.rationale}` : "",
      ``,
      `**Failed checks:** ${r.checks.filter((c) => !c.passed).map((c) => c.label).join(", ") || "none"}`,
      ``,
      r.judge?.saferResponse ? `**Safer reply:** ${r.judge.saferResponse}` : "",
      ``,
    );
  }
  if (systemPrompt) lines.push(`## System prompt audited`, ``, "```", systemPrompt, "```", ``);
  lines.push(`---`, `Scores combine an LLM judge (70%) with deterministic checks (30%), with safety caps for severe failures.`);
  return lines.join("\n");
}

export function download(filename: string, content: string, type = "text/markdown") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
