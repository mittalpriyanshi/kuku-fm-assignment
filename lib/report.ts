/**
 * Output files: everything an editor or reviewer needs, none of it hand-edited.
 *
 *   report.html        readable report: post-first five, ranked table, each clip's script
 *                      with hook and cliffhanger highlighted, quality stats, rejected drafts
 *   promos_ranked.csv  one row per promo, best first (opens in Sheets/Excel)
 *   cut_list.csv       one row per segment: episode file + in/out timecodes to cut from
 *   promos.json        everything (load it in the app's Review tab)
 *   run_log.json       config (no keys), counts, token usage and cost, quality summary
 *   show_bible.json    the model's who's-who for this show
 *   calls.jsonl        one line per model call; llm_raw/ holds every prompt and reply
 */
import type { CallLog } from "./ask";
import type { Message } from "./prompts";
import type { Promo, RunResult } from "./types";

export type Files = Record<string, string>;

export const segStr = (p: Pick<Promo, "segments">) => p.segments.map((s) => `Ep ${s.ep} ${s.start_tc}-${s.end_tc}`).join(" + ");

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

export function quality(res: RunResult) {
  const ps = res.promos.filter((p) => !p.duplicate_of);
  const judged = ps.filter((p) => p.judge);
  const q: Record<string, any> = { promos: ps.length, duplicates: res.promos.length - ps.length, judged: judged.length,
                                   postable: ps.filter((p) => p.postable).length };
  if (judged.length) {
    for (const k of ["hook_score", "cliffhanger_score", "standalone_score"] as const) {
      const vals = judged.map((p) => p.judge![k]);
      q[k] = { mean: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100,
               share_6_plus: Math.round((vals.filter((v) => v >= 6).length / vals.length) * 100) / 100 };
    }
    q.would_watch_next = Math.round((judged.filter((p) => p.judge!.would_watch_next).length / judged.length) * 100) / 100;
    q.with_confusing_refs = Math.round((judged.filter((p) => p.judge!.confusing.length).length / judged.length) * 100) / 100;
  }
  const st = res.stats.propose;
  if (st?.drafts) q.first_draft_pass_rate = Math.round((st.passed_first_time / st.drafts) * 100) / 100;
  return q;
}

export function buildFiles(res: RunResult, episodeFiles: Record<number, string>, logs: CallLog[],
                           raw: { stage: string; tag: string; messages: Message[]; reply: string; usage: unknown }[]): Files {
  const files: Files = {};
  files["promos.json"] = JSON.stringify(res, null, 1);
  files["show_bible.json"] = JSON.stringify(res.bible, null, 1);
  files["run_log.json"] = JSON.stringify({ show: res.show, created: res.created, episodes: res.episodes, runtime_s: res.runtime_s,
                                           stopped: res.stopped, notes: res.notes, model: res.model, judge_model: res.judge_model,
                                           config: res.config, stats: res.stats, usage: res.usage, quality: quality(res) }, null, 1);
  files["calls.jsonl"] = logs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  for (const r of raw) {
    const safe = (r.tag || "call").replace(/[^A-Za-z0-9_.#-]+/g, "_").slice(0, 80);
    files[`llm_raw/${r.stage}/${safe}.json`] = JSON.stringify({ model: res.model, messages: r.messages, reply: r.reply, usage: r.usage }, null, 1);
  }
  const head = ["rank", "post_first", "id", "source", "episodes", "segments", "duration_s", "hook_type", "hook", "cliffhanger", "why",
                "hook_score", "cliffhanger_score", "standalone_score", "score", "postable", "would_watch_next", "viewer_open_question",
                "duplicate_of", "fixes"];
  files["promos_ranked.csv"] = toCsv([head, ...res.promos.map((p) => [
    p.rank ?? "", p.post_first ?? "", p.id, p.source, p.episodes.join(" "), segStr(p), p.duration, p.hook.type, p.hook.text,
    p.cliffhanger.text, p.why, p.score_parts?.hook, p.score_parts?.cliffhanger, p.score_parts?.standalone, p.score, p.postable,
    p.judge?.would_watch_next ?? "", p.judge?.open_question ?? "", p.duplicate_of ?? "", p.fixes.join(" | ")])]);
  const cut: unknown[][] = [["rank", "post_first", "promo_id", "segment", "episode", "episode_file", "in_tc", "out_tc", "in_s", "out_s",
                             "segment_s", "promo_total_s", "start_event", "end_event"]];
  for (const p of res.promos) {
    if (p.duplicate_of) continue;
    p.segments.forEach((s, i) => cut.push([p.rank, p.post_first ?? "", p.id, i + 1, s.ep, episodeFiles[s.ep] ?? "", s.start_tc, s.end_tc,
                                           s.start, s.end, s.duration, p.duration, s.start_event, s.end_event]));
  }
  files["cut_list.csv"] = toCsv(cut);
  files["report.html"] = renderHtml(res);
  return files;
}

// ------------------------------------------------------------------ html

const esc = (x: unknown) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1d1b;--mute:#6b6a65;--line:#e4e1d8;--card:#fff;--hook:#fff1b8;--cliff:#ffd9df;--ok:#1f7a4d;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--mute:#a19f97;--line:#34332f;--card:#1f1e1b;--hook:#5a4a10;--cliff:#5c2430;--ok:#6fcf97;--bad:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{margin:36px 0 10px;font-size:20px}
.mute{color:var(--mute)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.kpi b{display:block;font-size:20px}
table{border-collapse:collapse;width:100%;font-size:13.5px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.wrap{overflow-x:auto}.tc{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.hook{background:var(--hook)}.cliff{background:var(--cliff)}.tag{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:0 8px;font-size:12px;margin:0 4px 4px 0}
.ok{color:var(--ok)}.bad{color:var(--bad)}details{margin:6px 0}summary{cursor:pointer}.script div{padding:1px 6px;border-radius:4px}.warn{border-color:var(--bad)}`;

function scriptHtml(p: Promo): string {
  return `<div class="script">${(p.script ?? []).map((r) => r.cut ? `<div class="mute">== CUT ==</div>`
    : `<div class="${r.mark ?? ""}"><span class="tc">+${esc(r.t)} | Ep ${esc(r.ep)} ${esc(r.tc)}</span> ${esc(r.text)}</div>`).join("")}</div>`;
}

function card(p: Promo, open = false): string {
  const sp = p.score_parts, j = p.judge;
  const checks = Object.entries(p.checks ?? {}).map(([k, v]) => `<span class="tag ${v ? "ok" : "bad"}">${v ? "✓" : "✗"} ${esc(k.replace(/_/g, " "))}</span>`).join("");
  const judge = j ? `<p><b>Cold viewer</b> (${esc(j.model)}): ${esc(j.story)}<br><b>Left wondering:</b> ${esc(j.open_question)}<br>
<b>First 3 s:</b> ${esc(j.first_3_seconds)}${j.confusing.length ? `<br><b>Confusing:</b> ${esc(j.confusing.join("; "))}` : ""}${j.issues.length ? `<br><b>Issues:</b> ${esc(j.issues.join("; "))}` : ""}</p>` : "";
  return `<details class="card" ${open ? "open" : ""}><summary><b>#${p.rank} · ${esc(p.id)} · ${esc(segStr(p))} · ${p.duration.toFixed(1)} s · score ${p.score}${p.duplicate_of ? ` · duplicate of ${esc(p.duplicate_of)}` : ""}</b><br>
<span class="hook">Hook (${esc(p.hook.type)})</span> ${esc(p.hook.text)} &nbsp;→&nbsp; <span class="cliff">Cliffhanger</span> ${esc(p.cliffhanger.text)}</summary>
<p><b>Why it works:</b> ${esc(p.why)}<br><b>Scores</b> hook ${sp?.hook} · cliffhanger ${sp?.cliffhanger} · standalone ${sp?.standalone} (${esc(sp?.source)}) · early bonus ${sp?.early_bonus} · proposer's standalone risk: ${esc(p.standalone_risk)}</p>
${judge}<p>${checks}</p>${p.fixes.length ? `<p class="mute">Auto-fixes by code: ${esc(p.fixes.join("; "))}</p>` : ""}${scriptHtml(p)}</details>`;
}

export function renderHtml(res: RunResult): string {
  const q = quality(res);
  const u = res.usage.total, cost = res.usage.est_cost_usd_at_paid_prices;
  const st = res.stats.propose ?? {}, ss = res.stats.stitch ?? {};
  const ranked = res.promos.filter((p) => !p.duplicate_of);
  const first = ranked.filter((p) => p.post_first).sort((a, b) => a.post_first! - b.post_first!);
  const kpis: [string, unknown][] = [["Episodes", res.episodes.length], ["Promos", ranked.length], ["Postable (all scores ≥ 6)", q.postable],
    ["Drafts passing checks first time", q.first_draft_pass_rate != null ? `${Math.round(q.first_draft_pass_rate * 100)}%` : "-"],
    ["Model calls", u.calls], ["Tokens in / out", `${u.prompt_tokens.toLocaleString("en")} / ${u.completion_tokens.toLocaleString("en")}`],
    ["Est. cost at paid prices", cost != null ? `$${cost.toFixed(3)}` : "n/a"], ["Runtime", `${Math.round(res.runtime_s)} s`]];
  const pct = (x: number | undefined) => `${Math.round((x ?? 0) * 100)}%`;
  const qrows: [string, unknown][] = [
    ["Drafts proposed", st.drafts], ["Passed all checks first time", st.passed_first_time],
    ["Passed after a small code fix (snap/trim)", st.auto_fixed], ["Failed a check, sent back to the model once", st.sent_to_repair],
    ["Repaired drafts returned / valid", `${st.repair_drafts ?? 0} / ${st.repaired_ok ?? 0}`], ["Episodes the model failed on", st.episodes_failed],
    ["Cross-episode drafts / valid", `${ss.drafts ?? 0} / ${ss.valid ?? 0}`], ["Judged by cold viewer", q.judged],
    ["Mean hook / cliffhanger / standalone", ["hook_score", "cliffhanger_score", "standalone_score"].map((k) => q[k]?.mean ?? "-").join(" / ")],
    ["Share scoring 6+ (hook / cliff / standalone)", ["hook_score", "cliffhanger_score", "standalone_score"].map((k) => pct(q[k]?.share_6_plus)).join(" / ")],
    ["Cold viewer would watch next", pct(q.would_watch_next)], ["Cold viewer named something confusing", pct(q.with_confusing_refs)],
    ["Near-duplicates removed", q.duplicates]];
  const eps = res.episodes.length < 12 ? res.episodes.join(", ") : `${res.episodes[0]}–${res.episodes[res.episodes.length - 1]} (${res.episodes.length})`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Promo report · ${esc(res.show)}</title><style>${CSS}</style></head><body><main>
<h1>Promo report: ${esc(res.show)}</h1>
<p class="mute">Episodes ${esc(eps)} · model ${esc(res.model)} · judge ${esc(res.judge_model)} · ${esc(res.created)} UTC.
Timestamps are episode timecodes from the screenplay. Highlight: <span class="hook">hook</span>, <span class="cliff">cliffhanger</span>.</p>
${res.stopped ? `<div class="card warn"><b>${esc(res.stopped)}</b></div>` : ""}
<div class="grid">${kpis.map(([a, b]) => `<div class="card kpi"><span class="mute">${esc(a)}</span><b>${esc(b)}</b></div>`).join("")}</div>
<h2>Post these first</h2><p class="mute">Best score per angle: each pick uses a different kind of hook where possible, so the first posts also show which angle pulls viewers.</p>
${first.map((p) => `<p><b>${p.post_first}. ${esc(p.id)}</b>: ${esc(p.post_first_reason)}</p>${card(p, true)}`).join("")}
<h2>All promos, ranked</h2><div class="wrap"><table><tr><th>#</th><th>Post</th><th>ID</th><th>Segments</th><th>s</th><th>Hook type</th><th>Hook</th><th>Cliffhanger</th><th>H/C/S</th><th>Score</th></tr>
${ranked.map((p) => `<tr><td>${p.rank}</td><td>${p.post_first ?? ""}</td><td>${esc(p.id)}</td><td class="tc">${esc(segStr(p))}</td><td>${p.duration.toFixed(1)}</td><td>${esc(p.hook.type)}</td><td>${esc(p.hook.text)}</td><td>${esc(p.cliffhanger.text)}</td><td>${p.score_parts?.hook}/${p.score_parts?.cliffhanger}/${p.score_parts?.standalone}</td><td>${p.judge ? `<b>${p.score}</b>` : `<span class="mute">${p.score} (not judged)</span>`}</td></tr>`).join("")}</table></div>
<h2>Every promo with its script</h2>${ranked.map((p) => card(p)).join("")}
<h2>Quality checks</h2><div class="wrap"><table>${qrows.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join("")}</table></div>
<h3>Why drafts failed the code checks</h3><div class="wrap"><table><tr><th>Check</th><th>Count</th></tr>${Object.entries(st.errors ?? {}).sort((a: any, b: any) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("") || "<tr><td>none</td><td>0</td></tr>"}</table></div>
<h3>Rejected drafts</h3><div class="wrap"><table><tr><th>ID</th><th>Stage</th><th>Failed checks</th><th>Model's reason</th></tr>${res.rejected.map((p) => `<tr><td>${esc(p.id)}</td><td>${esc(p.stage)}</td><td>${esc(p.errors.join("; "))}</td><td>${esc(p.why)}</td></tr>`).join("") || "<tr><td colspan=4>none</td></tr>"}</table></div>
<h3>Run notes</h3><ul>${res.notes.map((n) => `<li>${esc(n)}</li>`).join("") || "<li>none</li>"}</ul>
<h3>Near-duplicates</h3><p>${esc(res.promos.filter((p) => p.duplicate_of).map((p) => `${p.id} (≈${p.duplicate_of})`).join(", ") || "none")}</p>
</main></body></html>`;
}
