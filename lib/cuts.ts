/**
 * Cut points and promo checks. Plain code: the model picks moments by event ID,
 * and these rules turn them into exact, editor-ready in/out points.
 *
 * Rules (all in config -> rules):
 *  - in/out points snap to a camera cut when one is close, and never split a line
 *  - the hook event starts within the first `hookWindow` seconds (brief: 3 s)
 *  - the clip ends on the cliffhanger: at most `cliffTail` s after it, and before
 *    the event that answers it (if that answer is in the same episode)
 *  - total length between minLen and maxLen (brief: 20-60 s)
 *  - at most maxSegments segments, each >= minSegment s, in story order, no overlap
 */
import { EPS, Episode, Event, Show, fmtTs } from "./parse";

export interface Rules {
  minLen: number; maxLen: number; hookWindow: number; cliffTail: number;
  minSegment: number; maxSegments: number; snapBack: number; snapFwd: number;
}

export const DEFAULT_RULES: Rules = {
  minLen: 20, maxLen: 60, hookWindow: 3, cliffTail: 3, minSegment: 3, maxSegments: 3, snapBack: 1.5, snapFwd: 1.5,
};

export interface Segment { ep: number; start: number; end: number; startEvent: string; endEvent: string }
export interface Ref { ep: number; event: string }

/** A promo as proposed by the model: event IDs only, no times. */
export interface Draft {
  segments: { ep: number; startEvent: string; endEvent: string }[];
  hook: Ref;
  cliff: Ref;
  answeredBy?: Ref | null;
  meta?: Record<string, unknown>;
}

export interface Built {
  ok: boolean;
  segments: Segment[];
  duration: number;
  hookOffset: number; // seconds from promo start to the hook event
  cliffTail: number; // seconds from the end of the cliffhanger event to the cut
  fixes: string[];
  errors: string[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
export const segDur = (s: { start: number; end: number }) => r2(s.end - s.start);

export function insideLine(ep: Episode, t: number): boolean {
  return ep.lines.some((ln) => ln.start + EPS < t && t < ln.end - EPS);
}

/** Latest camera cut in [earliest, t] that doesn't split a line; else t (or the start of the line t is in). */
export function cleanIn(ep: Episode, t: number, earliest: number): number {
  const cands = ep.cuts.filter((c) => c >= earliest - 1e-6 && c <= t + 1e-6 && !insideLine(ep, c));
  if (cands.length) return Math.max(...cands);
  if (!insideLine(ep, t)) return t;
  const starts = ep.lines.filter((ln) => ln.start + EPS < t && t < ln.end - EPS && ln.start >= earliest - 1e-6).map((ln) => ln.start);
  return starts.length ? Math.min(...starts) : t;
}

/** Earliest camera cut in [t, latest] that splits no line and includes no part of the next line. */
export function cleanOut(ep: Episode, t: number, latest: number): number {
  const next = ep.lines.filter((ln) => ln.start > t - EPS && ln.end > t + EPS).map((ln) => ln.start);
  const hard = Math.min(latest, next.length ? Math.min(...next) : ep.duration, ep.duration);
  const cands = ep.cuts.filter((c) => c >= t - 1e-6 && c <= hard + 1e-6 && !insideLine(ep, c));
  if (cands.length) return Math.min(...cands);
  if (insideLine(ep, t)) {
    // an overlapping line is still running: let it finish if allowed
    const ends = ep.lines.filter((ln) => ln.start + EPS < t && t < ln.end - EPS && ln.end <= hard + 1e-6).map((ln) => ln.end);
    if (ends.length) return Math.max(...ends);
  }
  return Math.min(t, ep.duration);
}

function resolve(show: Show, ref?: Ref | null): Event | undefined {
  if (!ref) return undefined;
  return show.episodes.find((e) => e.number === ref.ep)?.byId[ref.event];
}

export function build(show: Show, d: Draft, rules: Partial<Rules> = {}): Built {
  const r = { ...DEFAULT_RULES, ...rules };
  const errors: string[] = [];
  const fixes: string[] = [];
  const fail = (segs: Segment[] = []): Built => ({ ok: false, segments: segs, duration: 0, hookOffset: 0, cliffTail: 0, fixes, errors });
  const epOf = (n: number) => show.episodes.find((e) => e.number === n);

  // 1. every ID must exist: the model may not invent events or times
  let segs: Segment[] = [];
  d.segments.forEach((sg, i) => {
    const ep = epOf(sg.ep);
    if (!ep) { errors.push(`segment ${i + 1}: episode ${sg.ep} is not in the input`); return; }
    const bad = [sg.startEvent, sg.endEvent].find((x) => !ep.byId[x]);
    if (bad !== undefined) { errors.push(`segment ${i + 1}: unknown event id ${bad || "(empty)"} in ep ${sg.ep}`); return; }
    const s = ep.byId[sg.startEvent].start, e = ep.byId[sg.endEvent].end;
    if (e <= s) { errors.push(`segment ${i + 1}: ends before it starts (${sg.startEvent}..${sg.endEvent})`); return; }
    segs.push({ ep: sg.ep, start: s, end: e, startEvent: sg.startEvent, endEvent: sg.endEvent });
  });
  const H = resolve(show, d.hook), C = resolve(show, d.cliff), A = resolve(show, d.answeredBy);
  if (!H) errors.push(`hook event ${d.hook.event || "(empty)"} (ep ${d.hook.ep}) does not exist`);
  if (!C) errors.push(`cliffhanger event ${d.cliff.event || "(empty)"} (ep ${d.cliff.ep}) does not exist`);
  if (d.answeredBy && !A) fixes.push(`ignored unknown answer event ${d.answeredBy.event}`);
  if (errors.length || !segs.length || !H || !C) { if (!segs.length && !errors.length) errors.push("no segments"); return fail(segs); }

  // 2. story order; merge overlapping segments from the same episode
  segs.sort((a, b) => a.ep - b.ep || a.start - b.start);
  const merged: Segment[] = [segs[0]];
  for (const s of segs.slice(1)) {
    const last = merged[merged.length - 1];
    if (s.ep === last.ep && s.start < last.end - EPS) {
      last.end = Math.max(last.end, s.end); last.endEvent = s.endEvent;
      fixes.push("merged overlapping segments");
    } else merged.push(s);
  }
  segs = merged;
  const first = segs[0], last = segs[segs.length - 1];
  if (segs.length > r.maxSegments) errors.push(`${segs.length} segments (max ${r.maxSegments})`);
  if (H.ep !== first.ep || H.start > first.end - EPS) errors.push("the hook is not in the first segment");
  else if (first.start - H.start > r.hookWindow + EPS) errors.push(`the hook starts ${(first.start - H.start).toFixed(1)} s before the clip does`);
  if (C.ep !== last.ep || C.start < last.start - EPS) errors.push("the cliffhanger is not in the last segment");
  else if (C.end - last.end > 5) errors.push(`the cliffhanger ends ${(C.end - last.end).toFixed(1)} s after the clip does`);
  if (errors.length) return fail(segs);
  const ep0 = epOf(first.ep)!, epN = epOf(last.ep)!;

  // 3. open on the hook: start at most `hookWindow` s before it, on a clean cut
  const lo = Math.max(H.start - r.hookWindow + 0.25, 0);
  let s0 = Math.min(first.start, H.start);
  if (s0 < lo - EPS) {
    fixes.push(`start moved from ${fmtTs(s0)} so the hook lands in the first ${r.hookWindow} s`);
    s0 = H.start;
  }
  first.start = cleanIn(ep0, s0, lo);

  // 4. end on the cliffhanger: include the whole line, stop before its answer
  let latest = C.end + r.cliffTail;
  const answerHere = !!A && A.ep === last.ep && A.start > C.start + EPS;
  if (answerHere) {
    if (A!.start < C.end - EPS) errors.push("the answer starts before the cliffhanger line ends");
    latest = Math.min(latest, A!.start);
  }
  let e0 = Math.max(last.end, C.end);
  if (e0 > latest + EPS) { fixes.push(`end moved from ${fmtTs(e0)} back to the cliffhanger`); e0 = C.end; }
  last.end = cleanOut(epN, e0, Math.max(latest, e0));
  if (answerHere && last.end > A!.start + EPS) errors.push("the clip shows the answer to its own cliffhanger");

  // 5. inner joins also land on clean cuts
  segs.forEach((s, i) => {
    const ep = epOf(s.ep)!;
    if (i > 0) s.start = cleanIn(ep, s.start, s.start - r.snapBack);
    if (i < segs.length - 1) s.end = cleanOut(ep, s.end, s.end + r.snapFwd);
  });
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].ep === segs[i - 1].ep && segs[i].start < segs[i - 1].end - EPS) errors.push("segments overlap after snapping to cuts");
  }

  // 6. lengths and the 3-second hook rule
  segs.forEach((s, i) => {
    s.start = r2(s.start); s.end = r2(s.end);
    if (segDur(s) < r.minSegment - EPS) errors.push(`segment ${i + 1} is ${segDur(s).toFixed(1)} s (min ${r.minSegment} s)`);
  });
  const total = r2(segs.reduce((a, s) => a + segDur(s), 0));
  if (total < r.minLen - EPS) errors.push(`total ${total.toFixed(1)} s is under ${r.minLen} s`);
  if (total > r.maxLen + EPS) errors.push(`total ${total.toFixed(1)} s is over ${r.maxLen} s`);
  const hookOffset = r2(H.start - first.start);
  if (hookOffset < -EPS || hookOffset > r.hookWindow + EPS) errors.push(`hook starts ${hookOffset.toFixed(1)} s in (must be within ${r.hookWindow} s)`);
  return { ok: errors.length === 0, segments: segs, duration: total, hookOffset, cliffTail: r2(last.end - C.end), fixes, errors };
}

/** What a viewer of [a, b) sees and hears: shots/actions on screen, lines and sounds that start inside. */
export function eventsIn(ep: Episode, a: number, b: number): Event[] {
  return ep.events.filter((e) => {
    if (e.start >= b - EPS || e.end <= a + EPS) return false;
    if ((e.kind === "LINE" || e.kind === "SFX") && e.start < a - EPS) return false;
    return true;
  });
}

/** Shared seconds between two promos, as a share of the shorter one. */
export function overlap(a: { ep: number; start: number; end: number }[], b: { ep: number; start: number; end: number }[]): number {
  let shared = 0;
  for (const x of a) for (const y of b) if (x.ep === y.ep) shared += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
  const da = a.reduce((s, x) => s + (x.end - x.start), 0), db = b.reduce((s, x) => s + (x.end - x.start), 0);
  return shared / Math.max(Math.min(da, db), 1e-6);
}
