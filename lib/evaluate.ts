/**
 * How we know the picks are good (beyond the code checks every promo already passes).
 *
 * gold     A person hand-picks the promos they would post in a few episodes, *before*
 *          seeing the tool's output (gold.csv: episode,start,end,note). We report how many
 *          of those the tool also found (recall) and at what rank.
 * review   An editor marks the tool's picks approve/reject in the app (review.csv).
 *          Precision@K = share of the top K they would actually post.
 * compare  Two runs (e.g. two models, or AI vs the no-AI baseline) on the same show:
 *          how many top-K picks they share.
 */
import { fmtTs, tsToSec } from "./parse";
import type { Promo, RunResult } from "./types";

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  const [head, ...body] = rows;
  return (body ?? []).map((r) => Object.fromEntries((head ?? []).map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const t = (x: string) => (x.includes(":") ? tsToSec(x) : Number(x));
const TS = /\d{1,2}:\d{2}(?:\.\d+)?/g;
/** A gold row's span. Labellers often paste a line's whole range ("00:52.80–00:55.80") into
 *  start and end, sometimes with the dash mangled by Excel: use the earliest time in `start`
 *  and the latest time in `end`. */
export function goldSpan(start: string, end: string): [number, number] {
  const a = start.match(TS) ?? [start], b = end.match(TS) ?? [end];
  return [Math.min(...a.map(t)), Math.max(...b.map(t))];
}

/** Time overlap between a promo's footage in episode `ep` and [a, b], over their union. */
export function iou(p: Pick<Promo, "segments">, ep: number, a: number, b: number): number {
  const segs = p.segments.filter((s) => s.ep === ep);
  if (!segs.length) return 0;
  const inter = segs.reduce((acc, s) => acc + Math.max(0, Math.min(s.end, b) - Math.max(s.start, a)), 0);
  const mine = segs.reduce((acc, s) => acc + (s.end - s.start), 0);
  return inter / Math.max(mine + (b - a) - inter, 1e-6);
}

export function evaluate(res: RunResult, goldCsv?: string, reviewCsv?: string, top = 10, thr = 0.3) {
  const ranked = res.promos.filter((p) => !p.duplicate_of);
  const out: Record<string, unknown> = { promos: ranked.length };
  if (goldCsv) {
    const gold = parseCsv(goldCsv).filter((g) => g.episode && g.start && g.end);
    let hits = 0, hitsTop = 0;
    const rows = gold.map((g) => {
      const ep = Number(g.episode), [a, b] = goldSpan(g.start, g.end);
      let best: Promo | null = null, sc = 0;
      for (const p of ranked) { const v = iou(p, ep, a, b); if (v > sc) { sc = v; best = p; } }
      const found = sc >= thr;
      hits += found ? 1 : 0;
      hitsTop += found && (best?.rank ?? 999) <= top ? 1 : 0;
      return { episode: ep, gold: `${fmtTs(a)}-${fmtTs(b)}`, note: g.note ?? "", best_match: best?.id ?? null,
               iou: Math.round(sc * 100) / 100, match_rank: best?.rank ?? null, found };
    });
    const eps = new Set(gold.map((g) => Number(g.episode)));
    out.gold = { gold_promos: gold.length, found_by_tool: hits, recall: gold.length ? Math.round((hits / gold.length) * 100) / 100 : null,
                 [`found_in_top_${top}`]: hitsTop, tool_promos_in_gold_episodes: ranked.filter((p) => p.episodes.some((e) => eps.has(e))).length,
                 iou_threshold: thr, rows };
  }
  if (reviewCsv) {
    const rankOf = new Map(ranked.map((p) => [p.id, p.rank ?? 999]));
    const rev = parseCsv(reviewCsv).filter((r) => rankOf.has(r.promo_id));
    const ok = (r: Record<string, string>) => /^(a|y)/i.test(r.verdict ?? "");
    const topk = rev.filter((r) => (rankOf.get(r.promo_id) ?? 999) <= top);
    out.review = { reviewed: rev.length, [`reviewed_in_top_${top}`]: topk.length,
                   [`precision_at_${top}`]: topk.length ? Math.round((topk.filter(ok).length / topk.length) * 100) / 100 : null,
                   approved_overall: rev.filter(ok).length };
  }
  return out;
}

export function compare(a: RunResult, b: RunResult, top = 10, thr = 0.3) {
  const A = a.promos.filter((p) => !p.duplicate_of), B = b.promos.filter((p) => !p.duplicate_of);
  const shared = (x: Promo[], y: Promo[]) => x.slice(0, top).map((p) => {
    let best: Promo | null = null, sc = 0;
    for (const q of y) {
      const v = Math.max(0, ...p.segments.map((s) => iou(q, s.ep, s.start, s.end)));
      if (v > sc) { sc = v; best = q; }
    }
    return { id: p.id, match: sc >= thr ? best?.id ?? null : null, match_rank: sc >= thr ? best?.rank ?? null : null };
  });
  const pa = shared(A, B), pb = shared(B, A);
  return { run_a: `${a.model} (${a.created})`, run_b: `${b.model} (${b.created})`,
           [`a_top_${top}_found_in_b`]: pa.filter((x) => x.match).length, [`b_top_${top}_found_in_a`]: pb.filter((x) => x.match).length,
           a_pairs: pa, b_pairs: pb };
}
