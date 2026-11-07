"use client";
/**
 * The app. The browser runs the pipeline (lib/pipeline.ts) step by step and sends
 * each model call through /api/llm, which holds the API key. Results never leave
 * the browser unless you download them; uploads are not stored anywhere.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { strToU8, zipSync } from "fflate";
import { CacheEntry, CallLog, makeAsker } from "@/lib/ask";
import { DEFAULT_CONFIG, mergeConfig } from "@/lib/config";
import { LLMConfig, LLMError, PRESETS, resolveLLM } from "@/lib/llm";
import { Show, Source, guessTitle, loadShow, readZip } from "@/lib/parse";
import { runPipeline } from "@/lib/pipeline";
import type { Message } from "@/lib/prompts";
import { Files, buildFiles, renderHtml, segStr, toCsv } from "@/lib/report";
import type { Promo, RunResult } from "@/lib/types";

const STAGES = ["parse", "bible", "propose", "stitch", "judge"];
const SAMPLE = ["episode-001.txt", "episode-002.txt", "episode-003.txt"];
type Verdict = "" | "approve" | "reject";
type Review = Record<string, { verdict: Verdict; note: string }>;

// ---- small browser helpers (storage can be blocked: never let it break the app)
const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* full or blocked */ } },
};
const localCache = {
  async get(k: string) { const v = store.get(`pf:${k}`); return v ? (JSON.parse(v) as CacheEntry) : null; },
  async set(k: string, v: CacheEntry) { store.set(`pf:${k}`, JSON.stringify(v)); },
};
function download(name: string, data: string | Uint8Array, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function zipFiles(files: Files) {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), { level: 6 });
}

export default function Page() {
  // ---- settings
  const [preset, setPreset] = useState("gemini");
  const [model, setModel] = useState(DEFAULT_CONFIG.llm.model ?? "gemini-3.5-flash-lite");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [judgeModel, setJudgeModel] = useState("");
  const [episodes, setEpisodes] = useState("");
  const [perEp, setPerEp] = useState(DEFAULT_CONFIG.proposer.promosPerEpisode);
  const [stitch, setStitch] = useState(true);
  const [judge, setJudge] = useState(true);
  const [offline, setOffline] = useState(false);
  const [server, setServer] = useState<{ presetsWithServerKey: string[]; accessCodeRequired: boolean }>({ presetsWithServerKey: [], accessCodeRequired: false });
  const [accessCode, setAccessCode] = useState("");
  const [testMsg, setTestMsg] = useState("");

  // ---- data
  const [sources, setSources] = useState<Source[]>([]);
  const [title, setTitle] = useState("");
  const [show, setShow] = useState<Show | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Record<string, [number, number]>>({});
  const [error, setError] = useState("");
  const [waitMsg, setWaitMsg] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);
  const [files, setFiles] = useState<Files | null>(null);
  const [tab, setTab] = useState<"run" | "review" | "how">("run");
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/api/llm").then((r) => r.json()).then(setServer).catch(() => undefined);
    const code = new URLSearchParams(window.location.search).get("code") ?? store.get("pf:code") ?? "";
    if (code) { setAccessCode(code); store.set("pf:code", code); }
  }, []);

  useEffect(() => { // parse whenever the input changes (code only, instant)
    if (!sources.length) { setShow(null); return; }
    loadShow(sources, title).then(setShow).catch((e) => setError(String(e)));
  }, [sources, title]);

  const serverHasKey = server.presetsWithServerKey.includes(preset);

  function llmConfig(m = model): Partial<LLMConfig> {
    if (offline) return { preset: "fake" };
    const base = { ...DEFAULT_CONFIG.llm, preset: preset === "custom" ? undefined : preset, model: m.trim() };
    if (preset === "custom") return { ...base, provider: "openai_compatible", baseUrl: baseUrl.trim(), apiKeyEnv: "" };
    if (preset !== "gemini") { delete base.pricePerM; }
    return base;
  }

  function makeAsk(cfgPart: Partial<LLMConfig>, logs: CallLog[], raw: any[], signal?: AbortSignal) {
    const cfg = resolveLLM(cfgPart);
    const name = `${cfg.preset ?? cfg.provider}:${cfg.model}`;
    const send = async (messages: Message[], sig?: AbortSignal) => {
      const r = await fetch("/api/llm", {
        method: "POST", headers: { "content-type": "application/json" }, signal: sig,
        body: JSON.stringify({ llm: { preset: cfg.preset, provider: cfg.provider, baseUrl: preset === "custom" ? cfg.baseUrl : undefined,
                                      model: cfg.model, temperature: cfg.temperature, maxTokens: cfg.maxTokens, jsonMode: cfg.jsonMode },
                               messages, apiKey: apiKey.trim() || undefined, accessCode: accessCode || undefined }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new LLMError(data.error ?? `HTTP ${r.status} from /api/llm`,
                           { status: r.status, quota: !!data.quota, retryAfter: data.retryAfter,
                             retryable: data.retryable ?? (r.status >= 500 || r.status === 429) });
      }
      return data as { text: string; usage: any };
    };
    return {
      name,
      ask: makeAsker({
        model: name, rpm: offline ? 1e6 : cfg.rpm, maxAttempts: cfg.maxAttempts, fake: offline, signal,
        cacheScope: JSON.stringify([cfg.provider, cfg.baseUrl, cfg.model, cfg.temperature, cfg.maxTokens]),
        cache: offline ? undefined : localCache, send,
        onLog: (row) => { logs.push(row); setWaitMsg(""); },
        onRaw: (stage, tag, messages, reply, usage) => raw.push({ stage, tag, messages, reply, usage }),
        onRetry: (r) => setWaitMsg(`${r.stage} ${r.tag}: attempt ${r.attempt}/${r.maxAttempts} failed, retrying in ${r.waitS} s (${r.error.slice(0, 160)})`),
      }),
    };
  }

  async function onUpload(list: FileList | null) {
    if (!list?.length) return;
    const out: Source[] = [];
    for (const f of Array.from(list)) {
      if (f.name.toLowerCase().endsWith(".zip")) out.push(...readZip(new Uint8Array(await f.arrayBuffer())));
      else out.push({ name: f.name, text: await f.text() });
    }
    setError(""); setResult(null); setFiles(null);
    setTitle(list.length === 1 ? guessTitle(list[0].name) : "Uploaded show");
    setSources(out);
  }

  async function useSample() {
    const out = await Promise.all(SAMPLE.map(async (n) => ({ name: n, text: await (await fetch(`/sample_show/${n}`)).text() })));
    setError(""); setResult(null); setFiles(null); setTitle("Sample show (synthetic)"); setSources(out);
  }

  async function run() {
    if (!sources.length) return;
    setRunning(true); setError(""); setWaitMsg(""); setProgress({}); setResult(null); setFiles(null);
    abort.current = new AbortController();
    const logs: CallLog[] = [], raw: any[] = [];
    try {
      const cfg = mergeConfig(DEFAULT_CONFIG, {
        llm: llmConfig(), proposer: { promosPerEpisode: perEp }, stitch: { enabled: stitch }, judge: { enabled: judge },
      });
      if (offline) cfg.llm = { preset: "fake", concurrency: 4 };
      const main = makeAsk(cfg.llm, logs, raw, abort.current.signal);
      const j = judgeModel.trim() && !offline ? makeAsk(llmConfig(judgeModel), logs, raw, abort.current.signal) : null;
      const { result: res, show: s } = await runPipeline(sources, cfg, {
        ask: main.ask, judgeAsk: j?.ask, model: main.name, judgeModel: j?.name, logs, episodes, title, signal: abort.current.signal,
        progress: (stage, done, total) => setProgress((p) => ({ ...p, [stage]: [done, total] })),
      });
      setResult(res);
      setFiles(buildFiles(res, Object.fromEntries(s.episodes.map((e) => [e.number, e.source])), logs, raw));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false); setWaitMsg("");
    }
  }

  async function testModel() {
    setTestMsg("testing…");
    try {
      const { ask, name } = makeAsk(llmConfig(), [], []);
      const out = await ask([{ role: "user", content: `Reply with exactly this JSON: {"ok": true, "nonce": ${Date.now()}}` }], { stage: "check", tag: "test", fake: () => ({ ok: true }) });
      setTestMsg(out?.ok ? `✓ ${name} works` : `unexpected reply: ${JSON.stringify(out).slice(0, 120)}`);
    } catch (e) { setTestMsg(`✗ ${(e as Error).message.slice(0, 300)}`); }
  }

  const kept = useMemo(() => (result?.promos ?? []).filter((p) => !p.duplicate_of), [result]);
  const footage = show ? show.episodes.reduce((a, e) => a + e.duration, 0) / 60 : 0;

  return (
    <div className="shell">
      <aside className="side">
        <h2>Model</h2>
        <label>Provider
          <select value={preset} onChange={(e) => { setPreset(e.target.value); setModel(PRESETS[e.target.value]?.model ?? ""); }} disabled={offline}>
            {[...Object.keys(PRESETS).filter((k) => k !== "fake"), "custom"].map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label>Model<input value={model} onChange={(e) => setModel(e.target.value)} disabled={offline} /></label>
        {preset === "custom" && <label>Base URL (OpenAI-compatible)<input value={baseUrl} placeholder="https://…/v1/" onChange={(e) => setBaseUrl(e.target.value)} /></label>}
        <label>API key
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={offline}
                 placeholder={serverHasKey && preset !== "custom" ? "optional: uses the app's free key" : "paste your key"} />
        </label>
        {server.accessCodeRequired && !apiKey && <label>Access code<input value={accessCode} onChange={(e) => { setAccessCode(e.target.value); store.set("pf:code", e.target.value); }} /></label>}
        <label>Judge model <span className="mute">(optional, same provider)</span><input value={judgeModel} placeholder="same as above" onChange={(e) => setJudgeModel(e.target.value)} disabled={offline} /></label>
        <button className="ghost" onClick={testModel}>Test model</button>
        {testMsg && <p className="small">{testMsg}</p>}
        <h2>Run</h2>
        <label>Episodes<input value={episodes} placeholder="all, or e.g. 1-5,12" onChange={(e) => setEpisodes(e.target.value)} /></label>
        <label>Promos per episode: {perEp}<input type="range" min={1} max={3} value={perEp} onChange={(e) => setPerEp(Number(e.target.value))} /></label>
        <label className="check"><input type="checkbox" checked={stitch} onChange={(e) => setStitch(e.target.checked)} /> Cross-episode trailers</label>
        <label className="check"><input type="checkbox" checked={judge} onChange={(e) => setJudge(e.target.checked)} /> Cold-viewer judge</label>
        <label className="check"><input type="checkbox" checked={offline} onChange={(e) => setOffline(e.target.checked)} /> Offline stand-in model (plumbing test, no AI)</label>
        <p className="small mute">Keys are used for this session only and never stored. Uploaded scripts stay in your browser; each model call sends one episode&apos;s text to the provider you picked.</p>
      </aside>

      <main className="main">
        <header>
          <h1>Promo Finder</h1>
          <p className="mute">Finds 20–60 s promos in a microdrama&apos;s timed screenplay: <b>hook in the first 3 s</b>, <b>ends on a cliffhanger</b>, makes sense to a stranger.
            AI judges the drama; code owns every timestamp and rule; an editor makes the final call.</p>
        </header>
        <nav className="tabs">
          {(["run", "review", "how"] as const).map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {{ run: "1 · Find promos", review: `2 · Review & export${kept.length ? ` (${kept.length})` : ""}`, how: "How it works" }[t]}
            </button>
          ))}
        </nav>

        {tab === "run" && (
          <section>
            <div className="card drop">
              <input type="file" accept=".zip,.txt" multiple onChange={(e) => onUpload(e.target.files)} />
              <span className="mute">a .zip of the show, or several .txt screenplays</span>
              <span className="mute">or</span>
              <button className="ghost" onClick={useSample}>Use the sample show</button>
            </div>
            {show && (
              <p><b>{show.title}</b>: {show.episodes.length} episodes, {show.episodes.reduce((a, e) => a + e.events.length, 0).toLocaleString("en")} timed events,
                {" "}{footage.toFixed(1)} min of footage.
                {show.episodes.some((e) => e.warnings.length) && <span className="bad"> Parser warnings in {show.episodes.filter((e) => e.warnings.length).length} episodes.</span>}</p>
            )}
            {sources.length > 0 && !show?.episodes.length && <p className="bad">No timed events found. Is this a timed screenplay?</p>}
            <div className="row">
              <button className="primary" onClick={run} disabled={!show?.episodes.length || running}>{running ? "Running…" : "Find promos"}</button>
              {running && <button className="ghost" onClick={() => abort.current?.abort()}>Stop</button>}
              {running && <span className="small mute">A full 50-episode show is about 180 model calls, so free tiers with a low daily limit can&apos;t finish it in one day. Keep this tab open; if it stops, run again and finished calls are reused.</span>}
            </div>
            {Object.keys(progress).length > 0 && (
              <div className="card">
                {STAGES.filter((s) => progress[s]).map((s) => {
                  const [d, t] = progress[s];
                  return <div key={s} className="prog"><span>{s}</span><div className="bar"><div style={{ width: `${(100 * d) / Math.max(t, 1)}%` }} /></div><span className="small">{d}/{t}</span></div>;
                })}
              </div>
            )}
            {running && waitMsg && <p className="small mute">{waitMsg}</p>}
            {error && <p className="bad">{error}</p>}
            {result && <Summary result={result} files={files} onReview={() => setTab("review")} />}
          </section>
        )}

        {tab === "review" && <ReviewTab result={result} onLoad={(r) => { setResult(r); setFiles(null); }} />}
        {tab === "how" && <How />}
      </main>
    </div>
  );
}

function Summary({ result, files, onReview }: { result: RunResult; files: Files | null; onReview: () => void }) {
  const kept = result.promos.filter((p) => !p.duplicate_of);
  const u = result.usage.total;
  const first = kept.filter((p) => p.post_first).sort((a, b) => a.post_first! - b.post_first!);
  return (
    <div>
      {result.stopped && <p className="card bad">{result.stopped}</p>}
      <div className="kpis">
        {[["Promos", kept.length], ["Postable (all scores ≥ 6)", kept.filter((p) => p.postable).length], ["Model calls", `${u.calls} (${u.cache_hits} cached)`],
          ["Tokens in / out", `${Math.round(u.prompt_tokens / 1000)}k / ${Math.round(u.completion_tokens / 1000)}k`], ["Runtime", `${Math.round(result.runtime_s)} s`]]
          .map(([a, b]) => <div key={String(a)} className="card kpi"><span className="mute small">{a}</span><b>{b}</b></div>)}
      </div>
      <h3>Post these first</h3>
      {first.map((p) => (
        <div key={p.id} className="card">
          <b>{p.post_first}. {p.id}</b> · <code>{segStr(p)}</code> · {p.duration.toFixed(0)} s · score <b>{p.score}</b>
          <div><span className="hook">Hook ({p.hook.type.replace(/_/g, " ")})</span> {p.hook.text}</div>
          <div><span className="cliff">Cliffhanger</span> {p.cliffhanger.text}</div>
          <div className="mute">Why: {p.why}</div>
        </div>
      ))}
      <div className="row">
        {files && <button className="primary" onClick={() => download(`promos-${result.created.replace(/[: ]/g, "-")}.zip`, zipFiles(files), "application/zip")}>Download all outputs (.zip)</button>}
        <button className="ghost" onClick={onReview}>Review every promo →</button>
      </div>
      {result.notes.length > 0 && <details className="small"><summary>{result.notes.length} run notes</summary><ul>{result.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></details>}
    </div>
  );
}

function ReviewTab({ result, onLoad }: { result: RunResult | null; onLoad: (r: RunResult) => void }) {
  const storeKey = result ? `pf:review:${result.show}:${result.created}` : "";
  const [review, setReview] = useState<Review>({});
  const [filter, setFilter] = useState<"all" | "postable" | "first">("all");
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { setReview(storeKey ? JSON.parse(store.get(storeKey) ?? "{}") : {}); setSel(null); }, [storeKey]);
  const update = (id: string, v: Partial<Review[string]>) => {
    const prev = review[id] ?? { verdict: "" as Verdict, note: "" };
    const next = { ...review, [id]: { ...prev, ...v } };
    setReview(next); store.set(storeKey, JSON.stringify(next));
  };
  async function load(f?: File) {
    if (!f) return;
    try { onLoad(JSON.parse(await f.text())); } catch { alert("That file is not a promos.json from this tool."); }
  }
  const loader = <label className="card drop">Load a <code>promos.json</code> from an earlier run <input type="file" accept=".json" onChange={(e) => load(e.target.files?.[0])} /></label>;
  if (!result) return <section>{loader}<p className="mute">Or run the tool in tab 1.</p></section>;
  const kept = result.promos.filter((p) => !p.duplicate_of);
  const view = kept.filter((p) => filter === "all" || (filter === "postable" && p.postable) || (filter === "first" && p.post_first));
  const cur = kept.find((p) => p.id === sel) ?? null;
  const approved = kept.filter((p) => review[p.id]?.verdict === "approve");
  const exportCut = () => download("approved_cut_list.csv", toCsv([["rank", "promo_id", "segment", "episode", "in_tc", "out_tc", "segment_s", "hook", "cliffhanger", "note"],
    ...approved.flatMap((p) => p.segments.map((s, i) => [p.rank, p.id, i + 1, s.ep, s.start_tc, s.end_tc, s.duration, p.hook.text, p.cliffhanger.text, review[p.id]?.note ?? ""]))]), "text/csv");
  const exportReview = () => download("review.csv", toCsv([["promo_id", "rank", "verdict", "note"],
    ...kept.filter((p) => review[p.id]?.verdict || review[p.id]?.note).map((p) => [p.id, p.rank, review[p.id].verdict, review[p.id].note])]), "text/csv");
  return (
    <section>
      <p><b>{result.show}</b> · {result.episodes.length} episodes · model {result.model} · {result.created} UTC</p>
      <div className="row">
        {(["all", "postable", "first"] as const).map((f) => <button key={f} className={filter === f ? "pill on" : "pill"} onClick={() => setFilter(f)}>{{ all: "All", postable: "Postable", first: "Post-first five" }[f]}</button>)}
        <span className="mute small">{approved.length} approved · {kept.filter((p) => review[p.id]?.verdict === "reject").length} rejected</span>
      </div>
      <div className="tablewrap">
        <table>
          <thead><tr><th>#</th><th>ID</th><th>Segments</th><th>s</th><th>Hook</th><th>Cliffhanger</th><th>H/C/S</th><th>Score</th><th>Verdict</th></tr></thead>
          <tbody>
            {view.map((p) => (
              <tr key={p.id} className={sel === p.id ? "sel" : ""} onClick={() => setSel(p.id)}>
                <td>{p.rank}{p.post_first ? <span className="star" title={`post #${p.post_first}`}>★</span> : null}</td>
                <td>{p.id}</td><td className="tc">{segStr(p)}</td><td>{p.duration.toFixed(0)}</td>
                <td>{p.hook.text}</td><td>{p.cliffhanger.text}</td>
                <td>{p.score_parts?.hook}/{p.score_parts?.cliffhanger}/{p.score_parts?.standalone ?? "–"}</td><td>{p.judge ? <b>{p.score}</b> : <span className="mute" title="The judge call failed, so this is the proposer grading its own pick. Ranked below judged promos.">{p.score}<br /><span className="small">not judged</span></span>}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <select value={review[p.id]?.verdict ?? ""} onChange={(e) => update(p.id, { verdict: e.target.value as Verdict })}>
                    <option value="">–</option><option value="approve">approve</option><option value="reject">reject</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cur ? <Detail p={cur} note={review[cur.id]?.note ?? ""} onNote={(note) => update(cur.id, { note })} /> : <p className="mute">Click a row to see its script, checks and the cold viewer&apos;s notes.</p>}
      <div className="row">
        <button className="primary" onClick={exportCut} disabled={!approved.length}>Approved cut list (.csv)</button>
        <button className="ghost" onClick={exportReview}>Review sheet (.csv)</button>
        <button className="ghost" onClick={() => download("report.html", renderHtml(result), "text/html")}>Report (.html)</button>
      </div>
      {loader}
    </section>
  );
}

function Detail({ p, note, onNote }: { p: Promo; note: string; onNote: (s: string) => void }) {
  const j = p.judge, sp = p.score_parts;
  return (
    <div className="card detail">
      <h3>{p.id} · <code>{segStr(p)}</code> · {p.duration.toFixed(1)} s · score {p.score}</h3>
      <p><span className="hook">Hook ({p.hook.type.replace(/_/g, " ")})</span> {p.hook.text}<br /><span className="cliff">Cliffhanger</span> {p.cliffhanger.text}</p>
      <p><b>Why it works:</b> {p.why}<br /><b>Scores:</b> hook {sp?.hook} · cliffhanger {sp?.cliffhanger} · standalone {sp?.standalone ?? "–"} ({sp?.source})
        {sp?.early_bonus ? ` · early-episode bonus ${sp.early_bonus}` : ""}</p>
      {j && <p><b>Cold viewer understood:</b> {j.story}<br /><b>Left wondering:</b> {j.open_question}
        {j.confusing.length > 0 && <><br /><b>Confusing:</b> {j.confusing.join("; ")}</>}{j.issues.length > 0 && <><br /><b>Issues:</b> {j.issues.join("; ")}</>}</p>}
      <p className="small">{Object.entries(p.checks).map(([k, v]) => <span key={k} className={`tag ${v ? "ok" : "bad"}`}>{v ? "✓" : "✗"} {k.replace(/_/g, " ")}</span>)}
        {p.fixes.length > 0 && <span className="mute"> · code fixes: {p.fixes.join("; ")}</span>}</p>
      <div className="script">
        {(p.script ?? []).map((r, i) => r.cut ? <div key={i} className="mute">== CUT ==</div>
          : <div key={i} className={r.mark ?? ""}><span className="tc">+{r.t} · Ep{r.ep} {r.tc}</span> {r.text}</div>)}
      </div>
      <label>Editor note<input value={note} onChange={(e) => onNote(e.target.value)} placeholder="e.g. trim the first shot" /></label>
    </div>
  );
}

function How() {
  const rows = [
    ["Parse", "code", "Screenplay → timed events (every shot, action, line, sound). An AI fallback reads unknown layouts, but code keeps a timestamp only if it literally appears in the text."],
    ["Show bible", "AI · 1 call", "Who's who: speaker labels drift (one person is \"MAYA\" in one episode and \"THE WAITRESS\" in another)."],
    ["Propose", "AI · 1 call per episode", "Picks short moments and 1–3 promo drafts, naming events by ID only. The model never writes a timestamp."],
    ["Build & check", "code", "Exact in/out points on camera cuts, never mid-line; 20–60 s; hook starts in the first 3 s; ends on the cliffhanger, before the event that answers it; ≤ 3 segments of ≥ 3 s."],
    ["Repair", "AI · failures only", "A draft that fails a check goes back once with the exact error, then is re-checked by code."],
    ["Stitch", "AI · 1 call per show", "Cross-episode trailers from the moments (first is a hook, last a cliffhanger), same checks."],
    ["Judge", "AI · 1 call per promo", "A cold viewer sees only the clip's script: scores hook, cliffhanger and standalone, and says what it understood."],
    ["Rank", "code", "Weighted score + small early-episode bonus; near-duplicates removed; post-first five spread across hook types."],
    ["Review", "human", "The editor approves or rejects here and exports the cut list."],
  ];
  return (
    <section>
      <div className="tablewrap"><table><thead><tr><th>Step</th><th>Who</th><th>What</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r[0]}><td><b>{r[0]}</b></td><td>{r[1]}</td><td>{r[2]}</td></tr>)}</tbody></table></div>
      <p>Swap the model in the sidebar, or in <code>promo.config.json</code> for the command line. Any OpenAI-compatible API (Gemini, OpenAI, Groq, a company gateway) or Anthropic works.</p>
    </section>
  );
}
