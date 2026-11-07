/**
 * Settings. Every knob that changes results lives in promo.config.json:
 *  llm        which model (preset + model is the one line to change), throttle, prices for cost estimates
 *  judgeLlm   optional different model for the cold-viewer judge (avoids a model grading itself)
 *  rules      the brief's definition of a promo, enforced in code (cuts.ts)
 *  proposer   promos/moments per episode, one repair round, or mode "baseline" (no-AI comparison)
 *  stitch     cross-episode trailer promos
 *  judge      cold-viewer judge; maxCandidates caps calls to protect free-tier quotas
 *  rank       score weights, early-episode bonus, duplicate threshold, post-first set
 */
import type { Rules } from "./cuts";
import type { LLMConfig } from "./llm";
import file from "../promo.config.json";

export interface RankConfig {
  weights: { hook: number; cliffhanger: number; standalone: number };
  earlyBonus: number; earlyUntilEp: number; postableMin: number; duplicateOverlap: number;
  postFirst: number; sameTypePenalty: number; sameEpisodePenalty: number;
}

export interface Config {
  llm: Partial<LLMConfig>;
  judgeLlm: Partial<LLMConfig>;
  rules: Rules;
  proposer: { mode: "ai" | "baseline"; promosPerEpisode: number; momentsPerEpisode: number; repair: boolean; baselineLen: number };
  stitch: { enabled: boolean; maxPromos: number; maxMoments: number };
  judge: { enabled: boolean; maxCandidates: number };
  rank: RankConfig;
  parse: { llmFallback: boolean };
}

export const DEFAULT_CONFIG = file as unknown as Config;

type Deep<T> = { [K in keyof T]?: T[K] extends object ? Deep<T[K]> : T[K] };

export function mergeConfig(base: Config, over: Deep<Config> = {}): Config {
  const merge = (a: any, b: any): any => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b ?? {})) {
      out[k] = v && typeof v === "object" && !Array.isArray(v) && a?.[k] && typeof a[k] === "object" ? merge(a[k], v) : v;
    }
    return out;
  };
  return merge(base, over);
}

export function parseEpisodeList(spec: string | undefined, available: number[]): number[] {
  if (!spec || !spec.trim()) return available;
  const want = new Set<number>();
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [a, b] = part.split("-").map((x) => parseInt(x, 10));
    if (b !== undefined && !isNaN(b)) for (let i = a; i <= b; i++) want.add(i);
    else if (!isNaN(a)) want.add(a);
  }
  return available.filter((n) => want.has(n));
}
