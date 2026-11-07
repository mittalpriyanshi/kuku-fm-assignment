/**
 * The "ask" wrapper every stage uses: send messages, get parsed JSON back.
 * It adds what free tiers need: a requests-per-minute throttle, retries on
 * 429/5xx, a cache (re-runs and resumed runs cost nothing), a JSON-repair retry,
 * and a log row per call (tokens, latency) for cost-per-show numbers.
 *
 * `send` is the only environment-specific part:
 *  - CLI: calls the provider directly (callModel)
 *  - browser: POSTs to /api/llm, which holds the API key server-side
 */
import { LLMError, Usage } from "./llm";
import type { Message } from "./prompts";

export interface AskMeta { stage: string; tag: string; fake?: () => unknown }
export type AskFn = (messages: Message[], meta: AskMeta) => Promise<any>;
export type SendFn = (messages: Message[], signal?: AbortSignal) => Promise<{ text: string; usage: Usage }>;

export interface CallLog {
  ts: number; stage: string; tag: string; model: string; prompt_tokens: number; completion_tokens: number;
  reasoning_tokens: number; truncated: number; latency_s: number; cache_hit: boolean; attempts: number; error: string | null;
}
export interface CacheEntry { model: string; text: string; usage: Usage; ts: number }
export interface Cache { get(key: string): Promise<CacheEntry | null>; set(key: string, v: CacheEntry): Promise<void> }

export interface RetryInfo { stage: string; tag: string; attempt: number; maxAttempts: number; waitS: number; error: string }

export class QuotaError extends Error {}

export function parseJson(text: string): any {
  let t = (text ?? "").trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, "");
  try { return JSON.parse(t); } catch { /* fall through */ }
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i < 0 || j <= i) throw new Error("no JSON object in the reply");
  t = t.slice(i, j + 1);
  try { return JSON.parse(t); } catch { return JSON.parse(t.replace(/,\s*([}\]])/g, "$1")); } // trailing commas
}

export async function sha256(s: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  if (signal?.aborted) return rej(new LLMError("stopped"));
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(new LLMError("stopped")); }, { once: true });
});

export function makeAsker(o: {
  model: string; // shown in logs
  cacheScope: string; // everything besides the messages that changes the reply (model, temperature...)
  send: SendFn;
  rpm: number;
  maxAttempts?: number;
  fake?: boolean;
  cache?: Cache;
  signal?: AbortSignal;
  onLog?: (row: CallLog) => void;
  onRaw?: (stage: string, tag: string, messages: Message[], reply: string, usage: Usage) => void;
  /** Called before each wait-and-retry, so a slow run never looks frozen. */
  onRetry?: (r: RetryInfo) => void;
}): AskFn {
  let nextOk = 0;
  const turn = async () => { // spread calls out to respect requests-per-minute
    const now = Date.now();
    const slot = Math.max(now, nextOk);
    nextOk = slot + 60_000 / Math.max(o.rpm, 0.1);
    if (slot > now) await sleep(slot - now, o.signal);
  };
  const log = (meta: AskMeta, usage: Partial<Usage>, t0: number, cacheHit: boolean, attempts: number, error: string | null) =>
    o.onLog?.({ ts: Math.round(Date.now() / 10) / 100, stage: meta.stage, tag: meta.tag, model: o.model,
                prompt_tokens: usage.prompt_tokens ?? 0, completion_tokens: usage.completion_tokens ?? 0,
                reasoning_tokens: usage.reasoning_tokens ?? 0, truncated: usage.truncated ?? 0,
                latency_s: Math.round((Date.now() - t0) / 10) / 100, cache_hit: cacheHit, attempts, error });

  async function once(messages: Message[], meta: AskMeta): Promise<{ text: string; usage: Usage; attempts: number }> {
    if (o.fake) {
      if (!meta.fake) throw new LLMError("the offline stand-in has no answer for this step");
      const text = JSON.stringify(meta.fake());
      const chars = messages.reduce((a, m) => a + m.content.length, 0);
      return { text, usage: { prompt_tokens: Math.round(chars / 4), completion_tokens: Math.round(text.length / 4) }, attempts: 1 };
    }
    let last = "";
    const max = o.maxAttempts ?? 6;
    for (let attempt = 1; attempt <= max; attempt++) {
      await turn();
      try {
        const r = await o.send(messages, o.signal);
        return { ...r, attempts: attempt };
      } catch (e) {
        if (!(e instanceof LLMError)) throw e;
        if (e.quota) throw new QuotaError(e.message);
        if (!e.retryable || o.signal?.aborted) throw e;
        last = e.message;
        if (attempt === max) break;
        const waitS = e.retryAfter ?? Math.min(90, 3 * 2 ** attempt);
        o.onRetry?.({ stage: meta.stage, tag: meta.tag, attempt, maxAttempts: max, waitS, error: e.message });
        await sleep(waitS * 1000, o.signal);
      }
    }
    throw new LLMError(`gave up after ${max} attempts (${last.slice(0, 300)})`);
  }

  return async function ask(messages: Message[], meta: AskMeta) {
    const key = await sha256(JSON.stringify({ s: o.cacheScope, m: messages }));
    const t0 = Date.now();
    const hit = await o.cache?.get(key).catch(() => null);
    if (hit) {
      try {
        const obj = parseJson(hit.text);
        log(meta, hit.usage, t0, true, 0, null);
        o.onRaw?.(meta.stage, meta.tag, messages, hit.text, hit.usage);
        return obj;
      } catch { /* bad cache entry: call again */ }
    }
    let r: { text: string; usage: Usage; attempts: number };
    try {
      r = await once(messages, meta);
    } catch (e) {
      log(meta, {}, t0, false, 0, (e as Error).message.slice(0, 300));
      throw e;
    }
    let obj: any;
    try {
      obj = parseJson(r.text);
    } catch {
      // one retry: show the model its reply and ask for valid JSON only
      const retry: Message[] = [...messages, { role: "assistant", content: r.text || "" },
        { role: "user", content: "That reply was not valid JSON. Reply again with only the JSON object." }];
      const r2 = await once(retry, meta);
      r = { text: r2.text, attempts: r.attempts + r2.attempts,
            usage: { prompt_tokens: r.usage.prompt_tokens + r2.usage.prompt_tokens,
                     completion_tokens: r.usage.completion_tokens + r2.usage.completion_tokens } };
      try {
        obj = parseJson(r.text);
      } catch {
        log(meta, r.usage, t0, false, r.attempts, "bad JSON");
        o.onRaw?.(meta.stage, meta.tag, messages, r.text, r.usage);
        throw new LLMError(`${meta.stage} ${meta.tag}: the model did not return valid JSON`);
      }
    }
    await o.cache?.set(key, { model: o.model, text: r.text, usage: r.usage, ts: Date.now() }).catch(() => undefined);
    o.onRaw?.(meta.stage, meta.tag, messages, r.text, r.usage);
    log(meta, r.usage, t0, false, r.attempts, null);
    return obj;
  };
}
