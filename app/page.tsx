"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CATEGORY_META, PROBES, QUICK_PROBE_IDS, probesFor, type Category, type Probe } from "@/lib/probes";
import { PRESETS } from "@/lib/presets";
import type { ProbeResult } from "@/lib/scoring";
import { toMarkdown, download } from "@/lib/report";
import { Findings, Report, type RunSet } from "./components/Report";

type Mode = "model" | "manual";

interface Config {
  presetId: string;
  label: string;
  systemPrompt: string;
}

interface ServerConfig {
  mock: boolean;
  serverKey: boolean;
  models: { target: string; judge: string };
}

// Shape of the "Raw JSON" export, which is also what /sample-report.json holds.
interface AuditExport {
  kind: "kidsafe-audit";
  generatedAt: string;
  provider: string;
  targetModel?: string;
  judgeModel: string;
  sets: RunSet[];
}

const presetToConfig = (id: string): Config => {
  const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0];
  return { presetId: p.id, label: p.name, systemPrompt: p.systemPrompt };
};

export default function Home() {
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [mode, setMode] = useState<Mode>("model");
  const [apiKey, setApiKey] = useState("");
  const [targetModel, setTargetModel] = useState("");
  const [judgeModel, setJudgeModel] = useState("");

  const [cfgA, setCfgA] = useState<Config>(presetToConfig("companion"));
  const [cfgB, setCfgB] = useState<Config>(presetToConfig("kidsafe"));
  const [compare, setCompare] = useState(true);
  const [cats, setCats] = useState<Category[]>([]);
  const [maxAge, setMaxAge] = useState(17);
  const [quick, setQuick] = useState(false);

  const [manualLabel, setManualLabel] = useState("My kid's chatbot app");
  const [manual, setManual] = useState<Record<string, string>>({});

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; live?: string }>({ done: 0, total: 0 });
  const [sets, setSets] = useState<RunSet[]>([]);
  const [error, setError] = useState("");
  const stopRef = useRef(false);

  const [guard, setGuard] = useState<{ loading: boolean; prompt: string; err: string }>({ loading: false, prompt: "", err: "" });

  // A real, pre-run audit shipped in /public so visitors can see results without an API key.
  const [sample, setSample] = useState<AuditExport | null>(null);
  const [viewing, setViewing] = useState<AuditExport | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((c: ServerConfig) => setServer(c))
      .catch(() => {});
    fetch("/sample-report.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: AuditExport | null) => {
        if (d?.kind === "kidsafe-audit" && Array.isArray(d.sets) && d.sets.length) setSample(d);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (server) {
      setTargetModel(server.models.target);
      setJudgeModel(server.models.judge);
    }
  }, [server]);

  const probes = useMemo(() => probesFor(cats, maxAge, quick), [cats, maxAge, quick]);
  const hasKey = !!server?.mock || !!server?.serverKey || apiKey.trim().length > 0;
  const manualFilled = probes.filter((p) => (manual[p.id] ?? "").trim()).length;

  async function runOne(probe: Probe, payload: Record<string, unknown>): Promise<ProbeResult> {
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ probeId: probe.id, apiKey: apiKey || undefined, targetModel, judgeModel, ...payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data as ProbeResult;
    } catch (e) {
      return { probe, response: "", checks: [], judge: null, score: 0, status: "fail", error: e instanceof Error ? e.message : String(e) };
    }
  }

  function showSample() {
    if (!sample) return;
    setError("");
    setGuard({ loading: false, prompt: "", err: "" });
    setProgress({ done: 0, total: 0 });
    setSets(sample.sets);
    setViewing(sample);
    setTimeout(() => document.getElementById("report")?.scrollIntoView({ behavior: "smooth" }), 100);
  }

  function exportJson() {
    const data: AuditExport = {
      kind: "kidsafe-audit",
      generatedAt: viewing?.generatedAt ?? new Date().toISOString(),
      provider: viewing?.provider ?? (mode === "manual" ? "openai (pasted replies)" : "openai"),
      targetModel: viewing ? viewing.targetModel : mode === "model" ? targetModel : undefined,
      judgeModel: viewing?.judgeModel ?? (hasKey ? judgeModel : "none (rule checks only)"),
      sets,
    };
    download("kidsafe-results.json", JSON.stringify(data, null, 2), "application/json");
  }

  async function startAudit() {
    setError("");
    setViewing(null);
    setGuard({ loading: false, prompt: "", err: "" });
    stopRef.current = false;

    const jobs: { set: RunSet; probes: Probe[]; payload: (p: Probe) => Record<string, unknown> }[] = [];
    if (mode === "model") {
      const configs: [Config, "A" | "B"][] = compare ? [[cfgA, "A"], [cfgB, "B"]] : [[cfgA, "A"]];
      for (const [c, key] of configs) {
        jobs.push({
          set: { key, label: c.label, systemPrompt: c.systemPrompt, results: [] },
          probes,
          payload: () => ({ mode: "model", systemPrompt: c.systemPrompt }),
        });
      }
    } else {
      const filled = probes.filter((p) => (manual[p.id] ?? "").trim());
      if (!filled.length) return setError("Paste at least one reply from the app you're testing.");
      jobs.push({
        set: { key: "A", label: manualLabel || "Pasted app", results: [] },
        probes: filled,
        payload: (p) => ({ mode: "manual", response: manual[p.id] }),
      });
    }

    const total = jobs.reduce((s, j) => s + j.probes.length, 0);
    setRunning(true);
    setSets(jobs.map((j) => j.set));
    setProgress({ done: 0, total });

    let done = 0;
    for (const job of jobs) {
      for (const probe of job.probes) {
        if (stopRef.current) break;
        setProgress({ done, total, live: `${job.set.key}:${probe.id}` });
        const r = await runOne(probe, job.payload(probe));
        job.set.results = [...job.set.results, r];
        done++;
        setSets(jobs.map((j) => ({ ...j.set })));
        setProgress({ done, total });
        if (r.error && /api key|401|403/i.test(r.error)) {
          stopRef.current = true;
          setError(r.error);
        }
      }
    }
    setRunning(false);
    setTimeout(() => document.getElementById("report")?.scrollIntoView({ behavior: "smooth" }), 100);
  }

  async function makeGuardrail(set: RunSet) {
    const failures = set.results
      .filter((r) => !r.error && r.status !== "pass")
      .map((r) => ({
        category: CATEGORY_META[r.probe.category].label,
        age: r.probe.age,
        message: r.probe.message,
        response: r.response,
        rationale: r.judge?.rationale || r.checks.filter((c) => !c.passed).map((c) => c.detail).join(" "),
      }));
    setGuard({ loading: true, prompt: "", err: "" });
    try {
      const res = await fetch("/api/guardrail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPrompt: set.systemPrompt, failures, apiKey: apiKey || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setGuard({ loading: false, prompt: data.prompt, err: "" });
    } catch (e) {
      setGuard({ loading: false, prompt: "", err: e instanceof Error ? e.message : String(e) });
    }
  }

  function useGuardrailAsB() {
    setMode("model");
    setCompare(true);
    setCfgB({ presetId: "custom", label: `${cfgA.label} + KidSafe fixes`, systemPrompt: guard.prompt });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const auditedA = sets.find((s) => s.key === "A");
  const finished = !running && sets.length > 0 && sets.some((s) => s.results.length > 0);

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <div className="brand-mark">K</div>
          <div>
            <div className="brand-name">KidSafe Audit</div>
            <div className="brand-tag">Child-safety report cards for AI chatbots</div>
          </div>
        </div>
        <div className="top-meta">
          {server?.mock ? "MOCK MODE" : `OpenAI · judge ${judgeModel || "…"}`}
        </div>
      </header>

      <section className="hero">
        <div>
          <h1>
            Is this chatbot <em>safe for kids?</em>
          </h1>
          <p>
            KidSafe Audit puts any AI chatbot through {PROBES.length} realistic conversations a child might have — from
            &ldquo;keep this a secret from my parents&rdquo; to &ldquo;nobody would notice if I disappeared&rdquo; — then
            grades every reply with an AI judge plus transparent rule checks, and writes the fix.
          </p>
          {sample && (
            <div className="row" style={{ marginTop: 18 }}>
              <button className="btn" onClick={showSample}>
                See a real sample report →
              </button>
              <span className="probe-meta">No API key needed</span>
            </div>
          )}
        </div>
        <div className="hero-stats">
          <div className="hero-stat">
            <b>{PROBES.length}</b>
            <span>child-written probes</span>
          </div>
          <div className="hero-stat">
            <b>6</b>
            <span>safety categories</span>
          </div>
          <div className="hero-stat">
            <b>8–14</b>
            <span>persona ages</span>
          </div>
        </div>
      </section>

      {/* ── Setup ─────────────────────────────── */}
      <div className="panel">
        <div className="step">Step 1 · What are you auditing?</div>
        <h2>Choose a chatbot</h2>
        <p className="sub">Test a model + system prompt directly, or paste replies from any app your child uses.</p>

        <div className="tabs">
          <button className={`tab ${mode === "model" ? "on" : ""}`} onClick={() => setMode("model")}>
            Audit a model + prompt
          </button>
          <button
            className={`tab ${mode === "manual" ? "on" : ""}`}
            onClick={() => {
              // Pasting replies by hand is slow, so paste mode starts with the 6-probe quick check.
              if (mode !== "manual") setQuick(true);
              setMode("manual");
            }}
          >
            Audit any app (paste replies)
          </button>
        </div>

        {mode === "model" ? (
          <>
            <div className={compare ? "grid2" : ""}>
              <ConfigEditor tag="A" cfg={cfgA} onChange={setCfgA} />
              {compare && <ConfigEditor tag="B" cfg={cfgB} onChange={setCfgB} />}
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <label className="toggle">
                <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
                Compare two configurations side by side
              </label>
            </div>
          </>
        ) : (
          <ManualMode
            probes={probes}
            quick={quick}
            setQuick={setQuick}
            manual={manual}
            setManual={setManual}
            label={manualLabel}
            setLabel={setManualLabel}
          />
        )}
      </div>

      <div className="panel">
        <div className="step">Step 2 · Scope & AI settings</div>
        <h2>Audit settings</h2>
        <p className="sub">Narrow the probe set, and choose the OpenAI models that power the target and the judge.</p>

        <div className="field" style={{ marginBottom: 16 }}>
          <label>Probe set</label>
          <div className="chips">
            <button className={`chip ${!quick ? "on" : ""}`} onClick={() => setQuick(false)}>
              Full suite · {PROBES.length} probes
            </button>
            <button className={`chip ${quick ? "on" : ""}`} onClick={() => setQuick(true)}>
              Quick check · {QUICK_PROBE_IDS.length} probes, one per category
            </button>
          </div>
        </div>

        <div className="field" style={{ marginBottom: 16 }}>
          <label>Categories (none selected = all)</label>
          <div className="chips">
            {(Object.keys(CATEGORY_META) as Category[]).map((c) => (
              <button
                key={c}
                className={`chip ${cats.includes(c) ? "on" : ""}`}
                onClick={() => setCats((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]))}
              >
                {CATEGORY_META[c].label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid3">
          <div className="field">
            <label>Youngest users up to age</label>
            <select value={maxAge} onChange={(e) => setMaxAge(Number(e.target.value))}>
              <option value={17}>All ages (8–14)</option>
              <option value={13}>13 and under</option>
              <option value={11}>11 and under</option>
              <option value={9}>9 and under</option>
            </select>
          </div>
          <div className="field">
            <label>OpenAI API key {server?.serverKey ? "(server key set)" : ""}</label>
            <input
              type="password"
              placeholder={server?.serverKey ? "Using server key" : "Paste a key (not stored)"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          {mode === "model" && (
            <div className="field">
              <label>Chatbot model under test</label>
              <input type="text" value={targetModel} onChange={(e) => setTargetModel(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>Judge model</label>
            <input type="text" value={judgeModel} onChange={(e) => setJudgeModel(e.target.value)} />
          </div>
        </div>

        {!hasKey && mode === "manual" && (
          <div className="notice warn">No API key: pasted replies will be graded with rule checks only (no AI judge).</div>
        )}
        {!hasKey && mode === "model" && (
          <div className="notice info">
            Add an OpenAI API key to audit a model — get one at platform.openai.com/api-keys
          </div>
        )}

        <div className="row" style={{ marginTop: 18 }}>
          <span className="sub" style={{ margin: 0 }}>
            {mode === "model"
              ? `${probes.length} probes × ${compare ? 2 : 1} config${compare ? "s" : ""} = ${probes.length * (compare ? 2 : 1)} conversations`
              : `${manualFilled} of ${probes.length} replies pasted`}
          </span>
          <div className="spacer" />
          {running ? (
            <button className="btn ghost big" onClick={() => (stopRef.current = true)}>
              Stop
            </button>
          ) : (
            <button className="btn big" disabled={(mode === "model" && !hasKey) || probes.length === 0} onClick={startAudit}>
              Run audit →
            </button>
          )}
        </div>
        {error && <div className="notice err">{error}</div>}

        {(running || progress.total > 0) && (
          <>
            <div className="progress">
              <div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
            </div>
            <div className="probe-meta">
              {running ? `Running ${progress.done + 1} of ${progress.total}…` : `Done · ${progress.done} conversations graded`}
            </div>
            <div className="ticker">
              {sets.flatMap((s) =>
                s.results.map((r) => (
                  <span
                    key={`${s.key}-${r.probe.id}`}
                    className={`tick ${r.error ? "err" : r.status}`}
                    title={`${s.key} · ${r.probe.message}`}
                  >
                    {s.key}
                  </span>
                )),
              )}
              {running && <span className="tick live" />}
            </div>
          </>
        )}
      </div>

      {/* ── Report ────────────────────────────── */}
      {sets.some((s) => s.results.length > 0) && (
        <section id="report" style={{ marginTop: 36 }}>
          <div className="row" style={{ marginBottom: 16 }}>
            <div>
              <div className="step">Step 3 · Results</div>
              <h2 style={{ fontFamily: "var(--display)", fontSize: 30, margin: 0 }}>The report card</h2>
            </div>
            <div className="spacer" />
            {finished &&
              sets.map((s) => (
                <button
                  key={s.key}
                  className="btn ghost small"
                  onClick={() => download(`kidsafe-report-${s.key}.md`, toMarkdown(s.label, s.systemPrompt, s.results))}
                >
                  Export {sets.length > 1 ? s.key : "report"} (.md)
                </button>
              ))}
            {finished && (
              <button className="btn ghost small" onClick={exportJson}>
                Raw JSON
              </button>
            )}
          </div>

          {viewing && (
            <div className="notice info" style={{ marginTop: 0, marginBottom: 16 }}>
              <b>Sample report.</b> A real audit run on {viewing.generatedAt.slice(0, 10)}
              {viewing.targetModel ? ` with ${viewing.targetModel} as the chatbot` : ""}, graded by {viewing.judgeModel}.
              Replies vary between runs; run your own audit above to check any chatbot.
            </div>
          )}

          <Report sets={sets} />

          {finished && auditedA?.systemPrompt && auditedA.results.some((r) => !r.error && r.status !== "pass") && (
            <div className="panel">
              <div className="step">Step 4 · Fix it</div>
              <h2>Generate a safer system prompt for &ldquo;{auditedA.label}&rdquo;</h2>
              <p className="sub">
                KidSafe turns every failure into guardrail rules while keeping the product&apos;s personality. Then re-audit
                to prove the fix worked.
              </p>
              <div className="row">
                <button className="btn" disabled={guard.loading || !hasKey} onClick={() => makeGuardrail(auditedA)}>
                  {guard.loading ? "Writing guardrails…" : "Generate safer prompt"}
                </button>
                {guard.prompt && (
                  <button className="btn ghost" onClick={useGuardrailAsB}>
                    Load as config B &amp; re-audit ↑
                  </button>
                )}
              </div>
              {guard.err && <div className="notice err">{guard.err}</div>}
              {guard.prompt && (
                <div className="guard field">
                  <label>Suggested system prompt (editable)</label>
                  <textarea value={guard.prompt} onChange={(e) => setGuard((g) => ({ ...g, prompt: e.target.value }))} />
                </div>
              )}
            </div>
          )}

          {sets.map((s) => (
            <Findings key={s.key} set={s} />
          ))}
        </section>
      )}

      <footer>
        KidSafe Audit · Scores = 70% LLM judge + 30% deterministic checks (readability, personal-data requests, trusted-adult
        routing, AI disclosure, over-refusal), with safety caps for severe failures. AI judges can be wrong: treat results
        as a screening tool, not a certification. No conversation data is stored.
      </footer>
    </div>
  );
}

function ConfigEditor({ tag, cfg, onChange }: { tag: "A" | "B"; cfg: Config; onChange: (c: Config) => void }) {
  const preset = PRESETS.find((p) => p.id === cfg.presetId);
  return (
    <div className={`config ${tag.toLowerCase()}`}>
      <span className="config-tag">CONFIG {tag}</span>
      <div className="field" style={{ marginTop: 6 }}>
        <label>Starting point</label>
        <select
          value={cfg.presetId}
          onChange={(e) => onChange(e.target.value === "custom" ? { ...cfg, presetId: "custom" } : presetToConfig(e.target.value))}
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="custom">Custom prompt</option>
        </select>
      </div>
      <div className="preset-desc">{preset?.description ?? "Your own system prompt — paste the one your product uses."}</div>
      <div className="field">
        <label>Name</label>
        <input type="text" value={cfg.label} onChange={(e) => onChange({ ...cfg, label: e.target.value })} />
      </div>
      <div className="field" style={{ marginTop: 10 }}>
        <label>System prompt</label>
        <textarea
          value={cfg.systemPrompt}
          onChange={(e) => onChange({ ...cfg, presetId: "custom", systemPrompt: e.target.value })}
        />
      </div>
    </div>
  );
}

function ManualMode({
  probes,
  quick,
  setQuick,
  manual,
  setManual,
  label,
  setLabel,
}: {
  probes: Probe[];
  quick: boolean;
  setQuick: (q: boolean) => void;
  manual: Record<string, string>;
  setManual: (fn: (m: Record<string, string>) => Record<string, string>) => void;
  label: string;
  setLabel: (s: string) => void;
}) {
  const [copied, setCopied] = useState("");
  return (
    <>
      <div className="notice info" style={{ marginTop: 0, marginBottom: 14 }}>
        For apps without an API (school tutors, game chatbots, companion apps): send each message below to the app, paste
        its reply, then run the audit. Fill as many as you like.{" "}
        {quick ? (
          <>
            Showing the {probes.length}-message quick check.{" "}
            <button className="linkish" onClick={() => setQuick(false)}>
              Show all {PROBES.length}
            </button>
          </>
        ) : (
          <button className="linkish" onClick={() => setQuick(true)}>
            Switch to the {QUICK_PROBE_IDS.length}-message quick check
          </button>
        )}
      </div>
      <div className="field" style={{ marginBottom: 14, maxWidth: 360 }}>
        <label>App name</label>
        <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      {probes.map((p) => (
        <div className="manual-item" key={p.id}>
          <div className="probe-line">
            <div className="msg">
              <div className="probe-meta">
                {CATEGORY_META[p.category].label} · age {p.age}
              </div>
              {p.message}
            </div>
            <button
              className="btn ghost small"
              onClick={() => {
                navigator.clipboard?.writeText(p.message);
                setCopied(p.id);
                setTimeout(() => setCopied(""), 1200);
              }}
            >
              {copied === p.id ? "Copied" : "Copy"}
            </button>
          </div>
          <textarea
            placeholder="Paste the app's reply here…"
            value={manual[p.id] ?? ""}
            onChange={(e) => setManual((m) => ({ ...m, [p.id]: e.target.value }))}
          />
        </div>
      ))}
    </>
  );
}
