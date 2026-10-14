"use client";

import { useMemo, useState } from "react";
import { CATEGORY_META, type Category } from "@/lib/probes";
import { summarize, type ProbeResult } from "@/lib/scoring";

export interface RunSet {
  key: "A" | "B";
  label: string;
  systemPrompt?: string;
  results: ProbeResult[];
}

export function Report({ sets }: { sets: RunSet[] }) {
  const summaries = useMemo(() => sets.map((s) => ({ set: s, sum: summarize(s.results) })), [sets]);
  const cats = Object.keys(CATEGORY_META) as Category[];
  const shownCats = cats.filter((c) => summaries.some((x) => x.sum.categories.some((k) => k.category === c)));

  return (
    <>
      <div className="report-head">
        {summaries.map(({ set, sum }) => (
          <div className="card-sheet" key={set.key}>
            <div className="sheet-label">Report card · Config {set.key}</div>
            <div className="sheet-name">{set.label}</div>
            <div className="sheet-body">
              <div className={`grade ${sum.grade}`}>{sum.grade}</div>
              <div className="sheet-stats">
                <div>
                  <b>{sum.overall}</b>/100 safety score
                </div>
                <div>
                  <b>{sum.passRate}%</b> probes passed
                </div>
                <div>
                  <b style={{ color: sum.criticalCount ? "var(--fail)" : undefined }}>{sum.criticalCount}</b> high-severity findings
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <h2>By category</h2>
        <p className="sub">Average score per area of child safety (0–100).</p>
        {sets.length > 1 && (
          <div className="legend">
            {sets.map((s) => (
              <span key={s.key}>
                <i style={{ background: s.key === "A" ? "var(--a)" : "var(--b)" }} />
                {s.key}: {s.label}
              </span>
            ))}
          </div>
        )}
        <div className="bars">
          {shownCats.map((c) => (
            <div className="bar-row" key={c}>
              <div className="bar-label">
                {CATEGORY_META[c].label}
                <small>{CATEGORY_META[c].blurb}</small>
              </div>
              <div className="bar-track">
                {summaries.map(({ set, sum }) => {
                  const cs = sum.categories.find((k) => k.category === c);
                  const v = cs?.score ?? 0;
                  return (
                    <div className={`bar ${set.key.toLowerCase()}`} key={set.key} title={`${set.key}: ${v}/100`}>
                      <i style={{ width: `${v}%` }} />
                      <span>
                        {v}
                        {cs ? ` · ${cs.passed}/${cs.total}` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

type Filter = "issues" | "all" | Category;

export function Findings({ set }: { set: RunSet }) {
  const [filter, setFilter] = useState<Filter>("issues");
  const list = set.results
    .filter((r) => (filter === "all" ? true : filter === "issues" ? r.status !== "pass" || !!r.error : r.probe.category === filter))
    .sort((a, b) => a.score - b.score);

  return (
    <div className="panel">
      <h2>
        Findings · Config {set.key}: {set.label}
      </h2>
      <p className="sub">Each conversation, how it was graded, and what a safer reply looks like.</p>
      <div className="filters">
        {(["issues", "all"] as const).map((f) => (
          <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
            {f === "issues" ? "Needs attention" : "All probes"}
          </button>
        ))}
        {(Object.keys(CATEGORY_META) as Category[]).map((c) => (
          <button key={c} className={`chip ${filter === c ? "on" : ""}`} onClick={() => setFilter(c)}>
            {CATEGORY_META[c].label}
          </button>
        ))}
      </div>
      {list.length === 0 && <p className="sub">Nothing here — every probe in this view passed.</p>}
      {list.map((r) => (
        <Finding key={r.probe.id} r={r} />
      ))}
    </div>
  );
}

function Finding({ r }: { r: ProbeResult }) {
  const status = r.error ? "err" : r.status;
  return (
    <details className="finding">
      <summary>
        <span className={`pill ${status}`}>{r.error ? "error" : r.status}</span>
        <span className="f-msg">
          <small>
            {CATEGORY_META[r.probe.category].label} · age {r.probe.age}
          </small>
          {r.probe.message}
        </span>
        <span className="f-score">{r.error ? "—" : `${r.score}/10`}</span>
      </summary>
      <div className="f-body">
        {r.error ? (
          <div className="notice err">{r.error}</div>
        ) : (
          <>
            <div className="bubbles">
              <div className="bubble kid">
                <div className="bubble-who">child, age {r.probe.age}</div>
                {r.probe.message}
              </div>
              <div className="bubble bot">
                <div className="bubble-who">chatbot under test</div>
                {r.response}
              </div>
            </div>
            {r.judge && (
              <div className="why">
                <b>Judge · {r.judge.score}/10 · severity {r.judge.severity}</b>
                {r.judge.rationale}
              </div>
            )}
            {r.judge && r.judge.criteria.length > 0 && (
              <ul className="criteria">
                {r.judge.criteria.map((c, i) => (
                  <li key={i} className={c.met ? "" : "no"}>
                    {c.met ? "✓" : "✗"} {c.criterion}
                    {c.note ? ` — ${c.note}` : ""}
                  </li>
                ))}
              </ul>
            )}
            <div className="checks">
              {r.checks.map((c) => (
                <span key={c.id} className={`check ${c.passed ? "ok" : "no"}`} title={c.detail}>
                  {c.passed ? "✓" : "✗"} {c.label}
                </span>
              ))}
            </div>
            {r.judge?.saferResponse && r.status !== "pass" && (
              <div className="bubble safe">
                <div className="bubble-who">a safer reply would be</div>
                {r.judge.saferResponse}
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
}
