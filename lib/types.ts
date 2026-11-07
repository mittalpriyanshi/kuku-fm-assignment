/** Shapes of what the pipeline produces (and what promos.json contains). */
import type { CallLog } from "./ask";
import type { Bible, Moment } from "./prompts";

export interface EventRef { ep: number; id: string; start_tc: string; end_tc: string; text: string }

export interface PromoSegment {
  ep: number; start: number; end: number; start_tc: string; end_tc: string; duration: number;
  start_event: string; end_event: string;
}

export interface Judge {
  first_3_seconds: string; story: string; open_question: string; confusing: string[]; issues: string[];
  hook_score: number; cliffhanger_score: number; standalone_score: number; would_watch_next: boolean; model: string;
}

export interface ScriptRow { cut?: boolean; t?: string; ep?: number; tc?: string; id?: string; text?: string; mark?: "hook" | "cliff" | "" }

export interface Promo {
  id: string;
  source: "episode" | "episode (repaired)" | "stitched" | "baseline";
  valid: boolean;
  errors: string[];
  fixes: string[];
  stage?: string; // for rejected drafts
  episodes: number[];
  segments: PromoSegment[];
  duration: number;
  moments?: string[];
  hook: { text: string; type: string; event: EventRef | null; offset_s: number };
  cliffhanger: { text: string; event: EventRef | null; answered_by: EventRef | null; tail_s: number };
  why: string;
  standalone_risk: string;
  model_scores: { hook: number; cliffhanger: number };
  checks: Record<string, boolean>;
  judge: Judge | null;
  score: number | null;
  score_parts?: { hook: number; cliffhanger: number; standalone: number | null; early_bonus: number; source: string };
  postable?: boolean;
  rank: number | null;
  post_first: number | null;
  post_first_reason?: string;
  duplicate_of: string | null;
  script?: ScriptRow[];
}

export interface RunResult {
  show: string;
  created: string;
  episodes: number[];
  runtime_s: number;
  stopped: string | null;
  notes: string[];
  config: unknown;
  model: string;
  judge_model: string;
  stats: Record<string, any>;
  bible: Bible;
  promos: Promo[];
  rejected: Promo[];
  moments: Moment[];
  parse: { episode: number; source: string; parser: string; events: number; lines: number; duration_tc: string; warnings: string[] }[];
  usage: Usage;
}

export interface Usage {
  by_stage: Record<string, { calls: number; cache_hits: number; errors: number; prompt_tokens: number; completion_tokens: number; reasoning_tokens: number; latency_s: number }>;
  total: { calls: number; cache_hits: number; errors: number; prompt_tokens: number; completion_tokens: number; reasoning_tokens: number };
  est_cost_usd_at_paid_prices: number | null;
  price_per_m: { input?: number; output?: number };
  note: string;
}

export function usageSummary(rows: CallLog[], price: { input?: number; output?: number } = {}): Usage {
  const by: Usage["by_stage"] = {};
  for (const r of rows) {
    const s = (by[r.stage] ??= { calls: 0, cache_hits: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, latency_s: 0 });
    s.calls++; s.cache_hits += r.cache_hit ? 1 : 0; s.errors += r.error ? 1 : 0;
    s.prompt_tokens += r.prompt_tokens; s.completion_tokens += r.completion_tokens; s.reasoning_tokens += r.reasoning_tokens;
    s.latency_s = Math.round((s.latency_s + r.latency_s) * 10) / 10;
  }
  const total = { calls: 0, cache_hits: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0 };
  for (const s of Object.values(by)) for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += s[k];
  const cost = price.input != null && price.output != null
    ? Math.round((total.prompt_tokens / 1e6 * price.input + total.completion_tokens / 1e6 * price.output) * 10000) / 10000 : null;
  return { by_stage: by, total, est_cost_usd_at_paid_prices: cost, price_per_m: price,
           note: "Token counts include cached calls (what a fresh run would use); cost uses llm.pricePerM." };
}
