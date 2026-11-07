/**
 * Offline stand-in for the model (preset "fake"). It lets the whole pipeline run
 * with no key or network, for tests and dry runs. Its picks are dumb on purpose
 * (one draft per episode is deliberately too long, to exercise the repair path).
 * Never use its output as results.
 */
import type { Episode, Event, Show } from "./parse";
import type { Moment } from "./prompts";

const closest = (lines: Event[], t: number, key: "start" | "end" = "start") =>
  lines.reduce((a, b) => (Math.abs(b[key] - t) < Math.abs(a[key] - t) ? b : a));

export function bible(show: Show) {
  const counts = new Map<string, number>();
  for (const ep of show.episodes) for (const l of ep.lines) counts.set(l.speaker, (counts.get(l.speaker) ?? 0) + 1);
  return { premise: "(offline stand-in) " + (show.episodes[0]?.logline ?? ""),
           characters: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => ({ name: k, labels: [k], who: "character" })),
           arcs: [] };
}

const promo = (a: Event, b: Event, hook: Event, cliff: Event, why: string) => ({
  segments: [{ start_event: a.id, end_event: b.id }], hook_event: hook.id, hook_type: "shocking_line",
  hook: hook.text.slice(0, 70), cliffhanger_event: cliff.id, answered_by: null, cliffhanger: cliff.text.slice(0, 70),
  why, standalone_risk: "none", hook_strength: 6, cliffhanger_strength: 6,
});

export function propose(ep: Episode, nPromos: number, nMoments: number) {
  const lines = ep.lines;
  if (lines.length < 3) return { moments: [], promos: [] };
  const last = lines[lines.length - 1];
  const hook = closest(lines, last.end - 40);
  const first = lines[0];
  const far = closest(lines, first.start + 75, "end");
  const mid = closest(lines, ep.duration / 2);
  const after = closest(lines, mid.end + 8, "end");
  const lead = closest(lines, last.end - 9);
  return {
    promos: [promo(hook, last, hook, last, "stand-in: last 40 s, ends on the episode's final line"),
             promo(first, far, first, far, "stand-in: opening stretch (too long on purpose)")].slice(0, nPromos),
    moments: [
      { id: "m1", start_event: mid.id, end_event: after.id, kind: "hook", hook_event: mid.id, cliffhanger_event: null,
        answered_by: null, label: mid.text.slice(0, 60), strength: 6 },
      { id: "m2", start_event: lead.id, end_event: last.id, kind: "cliffhanger", hook_event: null, cliffhanger_event: last.id,
        answered_by: null, label: last.text.slice(0, 60), strength: 7 },
    ].slice(0, nMoments),
  };
}

export function repair(ep: Episode, failures: unknown[]) {
  const lines = ep.lines;
  const end = closest(lines, lines[0].start + 40, "end");
  return { promos: failures.map(() => promo(lines[0], end, lines[0], end, "stand-in: shortened opening")) };
}

export function stitch(moments: Moment[], n: number) {
  const out = [];
  for (const h of moments.filter((m) => m.hasHook)) {
    const c = moments.find((m) => m.hasCliff && m.ep > h.ep && h.duration + m.duration >= 20 && h.duration + m.duration <= 55);
    if (c) out.push({ moments: [h.id, c.id], hook_type: "reveal", hook: h.label, cliffhanger: c.label, why: "stand-in stitch",
                      standalone_risk: "none", hook_strength: 6, cliffhanger_strength: 6 });
    if (out.length >= n) break;
  }
  return { promos: out };
}

export function judge(segments: { ep: number; start: number; end: number }[]) {
  let seed = 0;
  for (const ch of JSON.stringify(segments)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const pick = (k: number, lo: number, hi: number) => lo + ((seed >>> (k * 3)) % (hi - lo + 1));
  return { first_3_seconds: "(stand-in)", hook_score: pick(1, 3, 8), story: "(stand-in)", open_question: "(stand-in)",
           cliffhanger_score: pick(2, 3, 9), standalone_score: pick(3, 4, 8), confusing: [], would_watch_next: seed % 2 === 0, issues: [] };
}
