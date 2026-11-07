/**
 * The pipeline, and who does what:
 *
 *   parse    code   screenplay -> timed events                         parse.ts
 *   bible    AI     who's who across inconsistent speaker labels       1 call per show
 *   propose  AI     per episode: moments + promo drafts, by event ID   1 call per episode
 *   build    code   exact cut points + hard checks (20-60 s, hook in   cuts.ts
 *                   3 s, ends on the cliffhanger, before its answer)
 *   repair   AI     only drafts that failed a check, once              <=1 call per episode
 *   stitch   AI     cross-episode trailers built from moments          1 call per show
 *   judge    AI     cold-viewer test: sees only the clip               1 call per promo
 *   rank     code   weighted score, dedupe, diverse post-first set     rank.ts
 *   review   human  editor approves or rejects in the app              app/page.tsx
 *
 * Runs unchanged in the browser and in the Node CLI: everything that talks to a
 * model goes through the `ask` function it is given.
 */
import { AskFn, CallLog, QuotaError } from "./ask";
import { Config, parseEpisodeList } from "./config";
import { Built, Draft, build, eventsIn, insideLine } from "./cuts";
import * as fake from "./fake";
import { Episode, Show, Source, fmtTs, getEp, label, loadShow } from "./parse";
import { Bible, HOOK_TYPES, Moment, bibleMessages, judgeMessages, proposeMessages, repairMessages, stitchMessages } from "./prompts";
import { rank } from "./rank";
import { EventRef, Judge, Promo, RunResult, ScriptRow, usageSummary } from "./types";

export interface RunOptions {
  ask: AskFn;
  judgeAsk?: AskFn; // a different model for the judge, if configured
  model: string;
  judgeModel?: string;
  logs: CallLog[]; // the asker's log rows (for token/cost numbers)
  episodes?: string; // "1-10,15"; empty = all
  title?: string;
  progress?: (stage: string, done: number, total: number) => void;
  signal?: AbortSignal;
}

const toInt = (x: unknown, dflt = 5) => {
  const n = Math.round(Number(x));
  return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : dflt;
};

/** Accept e14 / E014 / "14" from the model; return the episode's real id, or the raw string. */
function normId(ep: Episode, x: unknown): string | null {
  if (x === null || x === undefined) return null;
  const s = String(x).trim();
  if (!s || /^(null|none)$/i.test(s)) return null;
  const m = s.match(/^[eE]?0*(\d+)$/);
  if (m) {
    const width = ep.events.length ? ep.events[0].id.length - 1 : 3;
    const cand = `e${m[1].padStart(width, "0")}`;
    if (ep.byId[cand]) return cand;
  }
  return s;
}

const evref = (show: Show, ep: number, id: string | null | undefined): EventRef | null => {
  if (!id) return null;
  const e = show.episodes.find((x) => x.number === ep)?.byId[id];
  return e ? { ep: e.ep, id: e.id, start_tc: fmtTs(e.start), end_tc: fmtTs(e.end), text: label(e) } : null;
};

export function scriptRows(show: Show, p: Pick<Promo, "segments" | "hook" | "cliffhanger">): ScriptRow[] {
  const rows: ScriptRow[] = [];
  let offset = 0;
  p.segments.forEach((s, i) => {
    if (i) rows.push({ cut: true });
    const ep = show.episodes.find((e) => e.number === s.ep);
    if (!ep) return;
    for (const e of eventsIn(ep, s.start, s.end)) {
      const mark = p.hook.event && e.ep === p.hook.event.ep && e.id === p.hook.event.id ? "hook"
        : p.cliffhanger.event && e.ep === p.cliffhanger.event.ep && e.id === p.cliffhanger.event.id ? "cliff" : "";
      rows.push({ t: fmtTs(Math.max(e.start, s.start) - s.start + offset), ep: e.ep, tc: fmtTs(e.start), id: e.id, text: label(e), mark });
    }
    offset += s.end - s.start;
  });
  return rows;
}

export async function runPipeline(sources: Source[], cfg: Config, o: RunOptions): Promise<{ result: RunResult; show: Show }> {
  const t0 = Date.now();
  const notes: string[] = [];
  const stats: Record<string, any> = {};
  const progress = o.progress ?? (() => undefined);
  const judgeAsk = o.judgeAsk ?? o.ask;
  let quotaHit = false, stopped: string | null = null;
  const rules = cfg.rules;

  // ---- parse (code; the AI fallback only for unknown layouts)
  progress("parse", 0, 1);
  const full = await loadShow(sources, o.title || "Untitled show", cfg.parse.llmFallback ? o.ask : undefined);
  const keep = new Set(parseEpisodeList(o.episodes, full.episodes.map((e) => e.number)));
  const show: Show = { title: full.title, episodes: full.episodes.filter((e) => keep.has(e.number)) };
  if (!show.episodes.length) throw new Error("No episodes with timed events were found in the input.");
  progress("parse", 1, 1);

  const guard = (stage: string, e: unknown) => {
    if (e instanceof QuotaError) {
      if (!quotaHit) notes.push(`${stage}: ${e.message}`);
      quotaHit = true;
    } else if (o.signal?.aborted) {
      stopped = "Stopped by the user. Run again to resume: finished calls are cached.";
    } else {
      notes.push(`${stage}: ${(e as Error).message}`);
    }
  };
  async function pmap<T, R>(stage: string, items: T[], fn: (x: T) => Promise<R>): Promise<(R | null)[]> {
    const out: (R | null)[] = items.map(() => null);
    let next = 0, done = 0;
    progress(stage, 0, items.length);
    const worker = async () => {
      while (next < items.length) {
        const k = next++;
        if (!quotaHit && !o.signal?.aborted) {
          try { out[k] = await fn(items[k]); } catch (e) { guard(`${stage} [${(items[k] as any)?.number ?? (items[k] as any)?.id ?? k}]`, e); }
        }
        progress(stage, ++done, items.length);
      }
    };
    const n = Math.max(1, Math.min(Number(cfg.llm.concurrency ?? 3), items.length));
    await Promise.all(Array.from({ length: n }, worker));
    return out;
  }

  // ---- bible (AI)
  let bible: Bible = { premise: "", characters: [], arcs: [] };
  const baseline = cfg.proposer.mode === "baseline";
  if (!baseline) {
    progress("bible", 0, 1);
    try {
      bible = await o.ask(bibleMessages(show), { stage: "bible", tag: "show", fake: () => fake.bible(show) });
    } catch (e) {
      guard("bible", e);
      if (!quotaHit) notes.push("continuing without the show bible");
    }
    progress("bible", 1, 1);
  }

  // ---- helpers to turn model JSON into checked promos
  const draftOf = (ep: Episode, p: any): Draft => {
    const segs = (Array.isArray(p?.segments) ? p.segments : []).filter((s: any) => s && typeof s === "object")
      .map((s: any) => ({ ep: ep.number, startEvent: normId(ep, s.start_event) ?? "", endEvent: normId(ep, s.end_event) ?? "" }));
    const hook = normId(ep, p?.hook_event) ?? segs[0]?.startEvent ?? "";
    const cliff = normId(ep, p?.cliffhanger_event) ?? segs[segs.length - 1]?.endEvent ?? "";
    const ans = normId(ep, p?.answered_by);
    return { segments: segs, hook: { ep: ep.number, event: hook }, cliff: { ep: ep.number, event: cliff },
             answeredBy: ans ? { ep: ep.number, event: ans } : null, meta: p ?? {} };
  };

  const promoOf = (id: string, source: Promo["source"], d: Draft, b: Built): Promo => {
    const m = (d.meta ?? {}) as any;
    let htype = String(m.hook_type ?? "other").trim().toLowerCase().replace(/\s+/g, "_");
    if (!HOOK_TYPES.includes(htype)) htype = "other";
    const segments = b.segments.map((s) => ({ ep: s.ep, start: s.start, end: s.end, start_tc: fmtTs(s.start), end_tc: fmtTs(s.end),
                                              duration: Math.round((s.end - s.start) * 100) / 100, start_event: s.startEvent, end_event: s.endEvent }));
    const H = evref(show, d.hook.ep, d.hook.event), C = evref(show, d.cliff.ep, d.cliff.event);
    const A = d.answeredBy ? evref(show, d.answeredBy.ep, d.answeredBy.event) : null;
    let checks: Record<string, boolean> = {};
    if (b.ok) {
      const last = b.segments[b.segments.length - 1];
      const cEv = getEp(show, d.cliff.ep).byId[d.cliff.event];
      const aEv = d.answeredBy ? show.episodes.find((e) => e.number === d.answeredBy!.ep)?.byId[d.answeredBy.event] : undefined;
      checks = {
        length_20_60s: b.duration >= rules.minLen && b.duration <= rules.maxLen,
        hook_in_first_3s: b.hookOffset >= 0 && b.hookOffset <= rules.hookWindow,
        ends_on_cliffhanger: b.cliffTail <= rules.cliffTail + 1.5,
        cut_before_answer: !(aEv && aEv.ep === last.ep && aEv.start > cEv.start && last.end > aEv.start + 0.05),
        no_line_cut_in_half: b.segments.every((s) => !insideLine(getEp(show, s.ep), s.start) && !insideLine(getEp(show, s.ep), s.end)),
      };
    }
    return {
      id, source, valid: b.ok, errors: b.errors, fixes: b.fixes,
      episodes: [...new Set(b.segments.map((s) => s.ep))].sort((x, y) => x - y).concat(b.segments.length ? [] : [d.hook.ep]),
      segments, duration: b.duration,
      hook: { text: String(m.hook ?? ""), type: htype, event: H, offset_s: b.hookOffset },
      cliffhanger: { text: String(m.cliffhanger ?? ""), event: C, answered_by: A, tail_s: b.cliffTail },
      why: String(m.why ?? ""), standalone_risk: String(m.standalone_risk ?? ""),
      model_scores: { hook: toInt(m.hook_strength), cliffhanger: toInt(m.cliffhanger_strength) },
      checks, judge: null, score: null, rank: null, post_first: null, duplicate_of: null,
    };
  };

  const momentRules = { ...rules, minLen: 3, maxLen: 25, maxSegments: 1 };
  const momentsOf = (ep: Episode, items: any): { moments: Moment[]; bad: number } => {
    const moments: Moment[] = [];
    let bad = 0;
    (Array.isArray(items) ? items : []).forEach((m: any, i: number) => {
      if (!m || typeof m !== "object") return;
      const a = normId(ep, m.start_event), b = normId(ep, m.end_event);
      const h = normId(ep, m.hook_event), c = normId(ep, m.cliffhanger_event), ans = normId(ep, m.answered_by);
      if (!a || !b) { bad++; return; }
      const built = build(show, { segments: [{ ep: ep.number, startEvent: a, endEvent: b }], hook: { ep: ep.number, event: h ?? a },
                                  cliff: { ep: ep.number, event: c ?? b }, answeredBy: ans ? { ep: ep.number, event: ans } : null }, momentRules);
      if (!built.ok) { bad++; return; }
      const seg = built.segments[0];
      const key = eventsIn(ep, seg.start, seg.end).find((e) => e.kind === "LINE");
      moments.push({ id: `E${String(ep.number).padStart(2, "0")}.${m.id || `m${i + 1}`}`, ep: ep.number, startEvent: a, endEvent: b,
                     hookEvent: h, cliffhangerEvent: c, answeredBy: ans, hasHook: !!h, hasCliff: !!c, kind: String(m.kind ?? ""),
                     label: String(m.label ?? "").slice(0, 120), strength: toInt(m.strength), start: seg.start, end: seg.end,
                     duration: Math.round((seg.end - seg.start) * 100) / 100, keyLine: key ? `"${key.text}"`.slice(0, 140) : "" });
    });
    return { moments, bad };
  };

  // ---- propose (AI) -> build (code) -> repair (AI, failures only) -> build (code)
  const pc = cfg.proposer;
  const proposeOne = async (ep: Episode) => {
    if (baseline) {
      // No-AI baseline for comparison: the last ~40 s of each episode (episodes end on
      // cliffhangers), starting on the line nearest that point. Judged like everything else.
      const lines = ep.lines, last = lines[lines.length - 1];
      const target = Math.max(0, last.end - pc.baselineLen);
      const pool = lines.length > 1 ? lines.slice(0, -1) : lines;
      const hook = pool.reduce((a, b) => (Math.abs(b.start - target) < Math.abs(a.start - target) ? b : a));
      const d: Draft = { segments: [{ ep: ep.number, startEvent: hook.id, endEvent: last.id }], hook: { ep: ep.number, event: hook.id },
                         cliff: { ep: ep.number, event: last.id }, answeredBy: null,
                         meta: { hook_type: "other", hook: hook.text.slice(0, 90), cliffhanger: last.text.slice(0, 90),
                                 why: `baseline rule: last ~${pc.baselineLen} s of the episode`, hook_strength: 5, cliffhanger_strength: 5 } };
      return { moments: [] as Moment[], bad: 0, first: [[d, build(show, d, rules)] as [Draft, Built]], repaired: [] as [Draft, Built][] };
    }
    const msgs = proposeMessages(show, ep, bible, pc.promosPerEpisode, pc.momentsPerEpisode);
    const tag = `ep${String(ep.number).padStart(3, "0")}`;
    const reply = await o.ask(msgs, { stage: "propose", tag, fake: () => fake.propose(ep, pc.promosPerEpisode, pc.momentsPerEpisode) });
    const { moments, bad } = momentsOf(ep, reply?.moments);
    const first: [Draft, Built][] = (Array.isArray(reply?.promos) ? reply.promos : []).filter((p: any) => p && typeof p === "object")
      .map((p: any) => { const d = draftOf(ep, p); return [d, build(show, d, rules)] as [Draft, Built]; });
    const failures = first.map(([, b], i) => [i, b.errors] as [number, string[]]).filter(([, errs]) => errs.length > 0);
    const repaired: [Draft, Built][] = [];
    if (failures.length && pc.repair) {
      try {
        const r2 = await o.ask(repairMessages(msgs, reply, failures), { stage: "repair", tag, fake: () => fake.repair(ep, failures) });
        for (const p of Array.isArray(r2?.promos) ? r2.promos : []) {
          if (p && typeof p === "object") { const d = draftOf(ep, p); repaired.push([d, build(show, d, rules)]); }
        }
      } catch (e) {
        if (e instanceof QuotaError) throw e;
        notes.push(`repair ep ${ep.number}: ${(e as Error).message}`);
      }
    }
    return { moments, bad, first, repaired };
  };

  const results = await pmap("propose", show.episodes, proposeOne);
  const promos: Promo[] = [], rejected: Promo[] = [], moments: Moment[] = [];
  const ps = { episodes: show.episodes.length, episodes_failed: 0, drafts: 0, passed_first_time: 0, auto_fixed: 0,
               sent_to_repair: 0, repair_drafts: 0, repaired_ok: 0, rejected: 0, moments: 0, moments_rejected: 0,
               errors: {} as Record<string, number> };
  const countErr = (bucket: Record<string, number>, errs: string[]) => {
    for (const e of errs) { const k = e.replace(/[\d.]+/g, "N"); bucket[k] = (bucket[k] ?? 0) + 1; }
  };
  show.episodes.forEach((ep, i) => {
    const r = results[i];
    if (!r) { ps.episodes_failed++; return; }
    moments.push(...r.moments); ps.moments += r.moments.length; ps.moments_rejected += r.bad;
    let n = 0;
    const pid = () => `E${String(ep.number).padStart(2, "0")}-P${++n}`;
    for (const [d, b] of r.first) {
      ps.drafts++;
      const p = promoOf(pid(), baseline ? "baseline" : "episode", d, b);
      if (b.ok) { ps.passed_first_time++; ps.auto_fixed += b.fixes.length ? 1 : 0; promos.push(p); }
      else { ps.sent_to_repair++; p.stage = "first draft (sent to repair)"; rejected.push(p); countErr(ps.errors, b.errors); }
    }
    for (const [d, b] of r.repaired) {
      ps.repair_drafts++;
      const p = promoOf(pid(), "episode (repaired)", d, b);
      if (b.ok) { ps.repaired_ok++; ps.auto_fixed += b.fixes.length ? 1 : 0; promos.push(p); }
      else { ps.rejected++; p.stage = "after repair (dropped)"; rejected.push(p); }
    }
  });
  stats.propose = ps;

  // ---- stitch (AI): cross-episode trailers from moments, same checks
  const ss = { enabled: cfg.stitch.enabled && !baseline, drafts: 0, valid: 0, errors: {} as Record<string, number> };
  stats.stitch = ss;
  if (ss.enabled && !quotaHit && !o.signal?.aborted && new Set(moments.map((m) => m.ep)).size >= 2) {
    const ms = [...moments].sort((a, b) => b.strength - a.strength).slice(0, cfg.stitch.maxMoments)
      .sort((a, b) => a.ep - b.ep || a.start - b.start);
    const byId = Object.fromEntries(ms.map((m) => [m.id, m]));
    progress("stitch", 0, 1);
    let reply: any = null;
    try {
      reply = await o.ask(stitchMessages(show, bible, ms, cfg.stitch.maxPromos),
                          { stage: "stitch", tag: "show", fake: () => fake.stitch(ms, cfg.stitch.maxPromos) });
    } catch (e) { guard("stitch", e); }
    progress("stitch", 1, 1);
    (Array.isArray(reply?.promos) ? reply.promos : []).forEach((p: any, i: number) => {
      if (!p || typeof p !== "object") return;
      ss.drafts++;
      const ids: string[] = (Array.isArray(p.moments) ? p.moments : []).map((x: unknown) => String(x).trim());
      const chosen = ids.filter((x) => byId[x]).map((x) => byId[x]);
      const errs = ids.filter((x) => !byId[x]).map((x) => `unknown moment ${x}`);
      if (new Set(chosen.map((m) => m.ep)).size < 2) errs.push("needs moments from at least 2 episodes");
      if (chosen.length && !chosen[0].hasHook) errs.push("first moment has no hook");
      if (chosen.length && !chosen[chosen.length - 1].hasCliff) errs.push("last moment has no cliffhanger");
      const id = `X-P${i + 1}`;
      if (errs.length || !chosen.length) {
        countErr(ss.errors, errs);
        rejected.push({ ...promoOf(id, "stitched", { segments: [], hook: { ep: 0, event: "" }, cliff: { ep: 0, event: "" }, meta: p },
                                   { ok: false, segments: [], duration: 0, hookOffset: 0, cliffTail: 0, fixes: [], errors: errs.length ? errs : ["empty"] }),
                        moments: ids, stage: "stitch (dropped)", episodes: [] });
        return;
      }
      const first = chosen[0], last = chosen[chosen.length - 1];
      const d: Draft = { segments: chosen.map((m) => ({ ep: m.ep, startEvent: m.startEvent, endEvent: m.endEvent })),
                         hook: { ep: first.ep, event: first.hookEvent! }, cliff: { ep: last.ep, event: last.cliffhangerEvent! },
                         answeredBy: last.answeredBy ? { ep: last.ep, event: last.answeredBy } : null, meta: p };
      const b = build(show, d, rules);
      const promo = { ...promoOf(id, "stitched", d, b), moments: ids };
      if (b.ok) { ss.valid++; promos.push(promo); }
      else { promo.stage = "stitch (dropped)"; rejected.push(promo); countErr(ss.errors, b.errors); }
    });
  }

  // ---- judge (AI, cold viewer: sees only the clip)
  if (cfg.judge.enabled && promos.length && !quotaHit && !o.signal?.aborted) {
    const todo = [...promos].sort((a, b) => (b.model_scores.hook + b.model_scores.cliffhanger) - (a.model_scores.hook + a.model_scores.cliffhanger))
      .slice(0, cfg.judge.maxCandidates);
    const judged = await pmap("judge", todo, async (p) => {
      const out = await judgeAsk(judgeMessages(show, p.segments), { stage: "judge", tag: p.id, fake: () => fake.judge(p.segments) });
      const list = (x: unknown) => (Array.isArray(x) ? x.map(String).filter((s) => s.trim()).slice(0, 8) : []);
      const j: Judge = { first_3_seconds: String(out?.first_3_seconds ?? ""), story: String(out?.story ?? ""),
                         open_question: String(out?.open_question ?? ""), confusing: list(out?.confusing), issues: list(out?.issues),
                         hook_score: toInt(out?.hook_score, 0), cliffhanger_score: toInt(out?.cliffhanger_score, 0),
                         standalone_score: toInt(out?.standalone_score, 0), would_watch_next: !!out?.would_watch_next,
                         model: o.judgeModel ?? o.model };
      return j;
    });
    todo.forEach((p, i) => { p.judge = judged[i]; });
    stats.judge = { judged: judged.filter(Boolean).length, failed: judged.filter((j) => !j).length,
                    skipped_over_cap: Math.max(0, promos.length - todo.length), model: o.judgeModel ?? o.model };
  } else {
    stats.judge = { judged: 0, skipped: promos.length };
  }

  if (quotaHit) stopped = "Stopped early: the model's quota ran out. Run the same thing again later (or with another model): finished calls are cached, so it resumes where it stopped.";
  if (o.signal?.aborted && !stopped) stopped = "Stopped by the user. Run again to resume: finished calls are cached.";

  // ---- rank (code)
  const ranked = rank(promos, cfg.rank);
  for (const p of [...ranked, ...rejected]) p.script = scriptRows(show, p);
  const result: RunResult = {
    show: show.title, created: new Date().toISOString().replace("T", " ").slice(0, 19),
    episodes: show.episodes.map((e) => e.number), runtime_s: Math.round((Date.now() - t0) / 100) / 10,
    stopped, notes, config: cfg, model: o.model, judge_model: o.judgeModel ?? o.model, stats, bible,
    promos: ranked, rejected, moments,
    parse: show.episodes.map((e) => ({ episode: e.number, source: e.source, parser: e.parser, events: e.events.length,
                                       lines: e.lines.length, duration_tc: fmtTs(e.duration), warnings: e.warnings })),
    usage: usageSummary(o.logs, cfg.llm.pricePerM ?? {}),
  };
  return { result, show };
}
