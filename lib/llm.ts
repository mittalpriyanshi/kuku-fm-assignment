/**
 * One small client for any chat model. Swapping models is a config change:
 *   llm: { preset: "gemini", model: "gemini-3.5-flash-lite" }   <- the one line to change
 *
 * Two wire formats cover almost every provider:
 *  - openai_compatible: Gemini, OpenAI, Groq, OpenRouter, Cerebras, Mistral, a local
 *    Ollama/vLLM server, or any company gateway that speaks the OpenAI format
 *  - anthropic: Claude models through the native Messages API
 * plus "fake", an offline stand-in for tests and dry runs (see fake.ts).
 *
 * This file only sends one request. Throttling, retries, caching and logging
 * live in ask.ts, so the same code runs in the Node CLI and behind /api/llm.
 */
import type { Message } from "./prompts";

export type Provider = "openai_compatible" | "anthropic" | "fake";

export interface LLMConfig {
  preset?: string;
  provider: Provider;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  temperature: number | null;
  maxTokens: number;
  maxTokensParam: string; // "max_tokens", or "max_completion_tokens" for OpenAI reasoning models
  jsonMode: boolean;
  timeoutMs: number;
  rpm: number; // requests per minute: stay under the free tier's limit
  concurrency: number;
  maxAttempts: number;
  extraBody: Record<string, unknown>; // passed straight to the provider
  pricePerM: { input?: number; output?: number }; // USD per 1M tokens, for cost estimates
}

export const PRESETS: Record<string, { provider: Provider; baseUrl: string; apiKeyEnv: string; model: string }> = {
  gemini: { provider: "openai_compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", apiKeyEnv: "GEMINI_API_KEY", model: "gemini-3.5-flash-lite" },
  groq: { provider: "openai_compatible", baseUrl: "https://api.groq.com/openai/v1/", apiKeyEnv: "GROQ_API_KEY", model: "openai/gpt-oss-120b" },
  openai: { provider: "openai_compatible", baseUrl: "https://api.openai.com/v1/", apiKeyEnv: "OPENAI_API_KEY", model: "gpt-4.1-mini" },
  anthropic: { provider: "anthropic", baseUrl: "https://api.anthropic.com/", apiKeyEnv: "ANTHROPIC_API_KEY", model: "claude-sonnet-4-5" },
  openrouter: { provider: "openai_compatible", baseUrl: "https://openrouter.ai/api/v1/", apiKeyEnv: "OPENROUTER_API_KEY", model: "openai/gpt-oss-120b:free" },
  cerebras: { provider: "openai_compatible", baseUrl: "https://api.cerebras.ai/v1/", apiKeyEnv: "CEREBRAS_API_KEY", model: "gpt-oss-120b" },
  mistral: { provider: "openai_compatible", baseUrl: "https://api.mistral.ai/v1/", apiKeyEnv: "MISTRAL_API_KEY", model: "mistral-medium-latest" },
  ollama: { provider: "openai_compatible", baseUrl: "http://localhost:11434/v1/", apiKeyEnv: "", model: "llama3.1" },
  fake: { provider: "fake", baseUrl: "", apiKeyEnv: "", model: "stand-in" },
};

const DEFAULTS = {
  temperature: 0.2, maxTokens: 16000, maxTokensParam: "max_tokens", jsonMode: true, timeoutMs: 240_000,
  rpm: 8, concurrency: 3, maxAttempts: 6, extraBody: {}, pricePerM: {},
};

/** Fill a partial config from its preset and the defaults. Explicit fields win. */
export function resolveLLM(cfg: Partial<LLMConfig> = {}): LLMConfig {
  const preset = PRESETS[cfg.preset ?? (cfg.baseUrl ? "" : "gemini")] ?? {};
  const clean = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined && v !== ""));
  const out = { ...DEFAULTS, ...preset, ...clean } as LLMConfig;
  if (!out.provider) out.provider = "openai_compatible";
  if (out.provider !== "fake" && !out.baseUrl) throw new LLMError("llm.baseUrl is empty: pick a preset or set a baseUrl");
  return out;
}

export interface Usage { prompt_tokens: number; completion_tokens: number; reasoning_tokens?: number; truncated?: number }

export class LLMError extends Error {
  status?: number;
  retryAfter?: number; // seconds
  quota?: boolean; // daily quota used up: retrying now is pointless
  retryable?: boolean;
  constructor(message: string, extra: Partial<Pick<LLMError, "status" | "retryAfter" | "quota" | "retryable">> = {}) {
    super(message);
    this.name = "LLMError";
    Object.assign(this, extra);
  }
}

function retryAfterOf(res: Response, body: string): number | undefined {
  const h = res.headers.get("retry-after");
  if (h && !isNaN(Number(h))) return Math.min(120, Number(h) + 1);
  const m = body.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.min(120, Number(m[1]) + 1) : undefined;
}

async function post(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number, signal?: AbortSignal) {
  const t = AbortSignal.timeout(timeoutMs);
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers },
                      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, t]) : t });
}

function errorFor(cfg: LLMConfig, res: Response, body: string): LLMError {
  const name = `${cfg.preset ?? cfg.provider}:${cfg.model}`;
  if (res.status === 429 && /per ?day|PerDay|daily/i.test(body)) {
    return new LLMError(`${name}: daily quota used up. Run again later; finished calls are cached. ${body.slice(0, 300)}`,
                        { status: 429, quota: true, retryable: false });
  }
  const retryable = [408, 429, 500, 502, 503, 504, 529].includes(res.status);
  return new LLMError(`${name}: HTTP ${res.status}: ${body.slice(0, 500)}`,
                      { status: res.status, retryable, retryAfter: retryAfterOf(res, body) });
}

const NO_JSON_MODE = new Set<string>(); // provider/model pairs that rejected response_format

/** Send one chat request; returns the reply text and token usage, or throws LLMError. */
export async function callModel(cfg: LLMConfig, messages: Message[], apiKey: string, signal?: AbortSignal): Promise<{ text: string; usage: Usage }> {
  const name = `${cfg.preset ?? cfg.provider}:${cfg.model}`;
  if (cfg.provider === "fake") throw new LLMError("the fake provider has no network calls");
  let res: Response;
  try {
    if (cfg.provider === "anthropic") {
      const body: Record<string, unknown> = {
        model: cfg.model, max_tokens: cfg.maxTokens,
        system: messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n"),
        messages: messages.filter((m) => m.role !== "system"), ...cfg.extraBody,
      };
      if (cfg.temperature !== null) body.temperature = cfg.temperature;
      res = await post(cfg.baseUrl.replace(/\/+$/, "") + "/v1/messages", body,
                       { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, cfg.timeoutMs, signal);
      const text = await res.text();
      if (!res.ok) throw errorFor(cfg, res, text);
      const data = JSON.parse(text);
      const out = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      const usage: Usage = { prompt_tokens: data.usage?.input_tokens ?? 0, completion_tokens: data.usage?.output_tokens ?? 0 };
      if (data.stop_reason === "max_tokens") usage.truncated = 1;
      return { text: out, usage };
    }
    const send = (json: boolean) => {
      const body: Record<string, unknown> = { model: cfg.model, messages, [cfg.maxTokensParam]: cfg.maxTokens, ...cfg.extraBody };
      if (cfg.temperature !== null) body.temperature = cfg.temperature;
      if (json) body.response_format = { type: "json_object" };
      return post(cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions", body,
                  apiKey ? { authorization: `Bearer ${apiKey}` } : {}, cfg.timeoutMs, signal);
    };
    const jsonKey = `${cfg.baseUrl}|${cfg.model}`;
    const json = cfg.jsonMode && !NO_JSON_MODE.has(jsonKey);
    res = await send(json);
    let text = await res.text();
    if (res.status === 400 && json && text.includes("response_format")) {
      NO_JSON_MODE.add(jsonKey); // this provider/model has no JSON mode: rely on the prompt from now on
      res = await send(false);
      text = await res.text();
    }
    if (!res.ok) throw errorFor(cfg, res, text);
    const data = JSON.parse(text);
    const choice = data.choices?.[0] ?? {};
    let out = choice.message?.content;
    if (Array.isArray(out)) out = out.map((p: any) => p?.text ?? "").join("");
    if (!out) {
      throw new LLMError(`${name}: empty reply (finish_reason=${choice.finish_reason}); the provider may have blocked it or max_tokens is too low`,
                         { retryable: false });
    }
    const usage: Usage = { prompt_tokens: data.usage?.prompt_tokens ?? 0, completion_tokens: data.usage?.completion_tokens ?? 0 };
    const reasoning = data.usage?.completion_tokens_details?.reasoning_tokens;
    if (reasoning) usage.reasoning_tokens = reasoning;
    if (choice.finish_reason === "length") usage.truncated = 1;
    return { text: out, usage };
  } catch (e) {
    if (e instanceof LLMError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (signal?.aborted) throw new LLMError("stopped", { retryable: false });
    throw new LLMError(`${name}: network error: ${msg}`, { retryable: true });
  }
}
