/**
 * Ranking: plain, configurable code on top of the judge's scores.
 *
 * score = weighted mean of the cold-viewer judge's hook, cliffhanger and standalone
 *         scores (0-10) + a small bonus for early episodes (new viewers start at Ep 1,
 *         so a moment from Ep 3 pays off sooner than one from Ep 40)
 * Then: drop near-duplicates (promos sharing most of their footage) and pick a
 * "post first" set that covers different hook types, so the first posts also
 * test which angle pulls viewers best.
 */
import type { RankConfig } from "./config";
import { overlap } from "./cuts";
import type { Promo } from "./types";

function score(promos: Promo[], r: RankConfig) {
  const w = r.weights;
  for (const p of promos) {
    const j = p.judge;
    const h = j ? j.hook_score : p.model_scores.hook;
    const c = j ? j.cliffhanger_score : p.model_scores.cliffhanger;
    const s = j ? j.standalone_score : null;
    const parts: [number, number][] = [[w.hook, h], [w.cliffhanger, c], ...(s !== null ? [[w.standalone, s] as [number, number]] : [])];
    const base = parts.reduce((a, [wt, v]) => a + wt * v, 0) / parts.reduce((a, [wt]) => a + wt, 0);
    const firstEp = Math.min(...p.episodes);
    const bonus = r.earlyBonus * Math.max(0, 1 - (firstEp - 1) / Math.max(r.earlyUntilEp, 1));
    p.score = Math.round((base + bonus) * 100) / 100;
    p.score_parts = { hook: h, cliffhanger: c, standalone: s, early_bonus: Math.round(bonus * 100) / 100,
                      source: j ? "judge" : "proposer (not judged)" };
    p.postable = !!j && Math.min(h, c, s ?? 0) >= r.postableMin;
  }
}

/** Sort, mark duplicates, pick the post-first set. Returns the ranked list (duplicates last). */
export function rank(promos: Promo[], r: RankConfig): Promo[] {
  score(promos, r);
  promos.sort((a, b) => Number(!!b.judge) - Number(!!a.judge) || (b.score ?? 0) - (a.score ?? 0));
  const kept: Promo[] = [];
  for (const p of promos) {
    p.duplicate_of = kept.find((k) => overlap(p.segments, k.segments) >= r.duplicateOverlap)?.id ?? null;
    if (!p.duplicate_of) kept.push(p);
  }
  kept.forEach((p, i) => { p.rank = i + 1; });
  const pool = kept.filter((p) => p.postable);
  const candidates = pool.length ? [...pool] : [...kept]; // copy: picks are removed from it
  const chosen: Promo[] = [];
  while (candidates.length && chosen.length < r.postFirst) {
    const adj = (p: Promo) => (p.score ?? 0)
      - r.sameTypePenalty * chosen.filter((c) => c.hook.type === p.hook.type).length
      - r.sameEpisodePenalty * chosen.filter((c) => c.episodes.some((e) => p.episodes.includes(e))).length;
    const best = candidates.reduce((a, b) => (adj(b) > adj(a) ? b : a));
    candidates.splice(candidates.indexOf(best), 1);
    chosen.push(best);
  }
  chosen.forEach((p, i) => {
    p.post_first = i + 1;
    const sp = p.score_parts!;
    p.post_first_reason = `${p.hook.type.replace(/_/g, " ")} angle; score ${(p.score ?? 0).toFixed(1)} (hook ${sp.hook}, cliffhanger ${sp.cliffhanger}, standalone ${sp.standalone})`
      + (sp.early_bonus ? `; early-episode bonus ${sp.early_bonus.toFixed(2)}` : "");
  });
  return [...kept, ...promos.filter((p) => p.duplicate_of)];
}
