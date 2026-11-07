/**
 * POST /api/llm: forwards ONE model call. It exists only to keep the API key on
 * the server. The browser runs the pipeline and calls this once per step, so no
 * request comes near Vercel's 300 s function limit even on a 50-episode show.
 *
 * Safety: the server's own key is only ever sent to its preset's official URL
 * (a client can't point it at another server). Custom URLs need the caller's
 * own key. Optional APP_ACCESS_CODE env var locks the server key to people who
 * have the code (e.g. a link ending in ?code=...).
 *
 * GET /api/llm: which presets have a server key, and whether a code is required.
 */
import { NextRequest, NextResponse } from "next/server";
import { LLMConfig, LLMError, PRESETS, callModel, resolveLLM } from "@/lib/llm";
import type { Message } from "@/lib/prompts";

export const runtime = "nodejs";
export const maxDuration = 300;

const ALLOWED = ["preset", "provider", "baseUrl", "model", "temperature", "maxTokens", "maxTokensParam", "jsonMode", "extraBody"] as const;

export async function GET() {
  const withKey = Object.entries(PRESETS).filter(([, p]) => p.apiKeyEnv && process.env[p.apiKeyEnv]).map(([k]) => k);
  return NextResponse.json({ presetsWithServerKey: withKey, accessCodeRequired: !!process.env.APP_ACCESS_CODE });
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad JSON body" }, { status: 400 }); }
  const messages: Message[] = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length || !messages.every((m) => ["system", "user", "assistant"].includes(m?.role) && typeof m?.content === "string")) {
    return NextResponse.json({ error: "messages must be [{role, content}]" }, { status: 400 });
  }
  if (messages.reduce((a, m) => a + m.content.length, 0) > 400_000) {
    return NextResponse.json({ error: "prompt too large" }, { status: 413 });
  }
  const raw = Object.fromEntries(ALLOWED.filter((k) => body?.llm?.[k] !== undefined).map((k) => [k, body.llm[k]])) as Partial<LLMConfig>;
  let apiKey: string = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  let cfg: LLMConfig;
  try {
    if (!apiKey) {
      const code = process.env.APP_ACCESS_CODE;
      if (code && body?.accessCode !== code) {
        return NextResponse.json({ error: "This app's key needs an access code (or paste your own API key)." }, { status: 401 });
      }
      const preset = PRESETS[String(raw.preset ?? "")];
      apiKey = preset?.apiKeyEnv ? process.env[preset.apiKeyEnv] ?? "" : "";
      if (!preset || !apiKey) {
        return NextResponse.json({ error: `No server key for "${raw.preset ?? "custom"}". Paste your own API key in the sidebar.` }, { status: 400 });
      }
      // the server key only goes to the preset's own URL, with no extra parameters
      cfg = resolveLLM({ ...raw, provider: preset.provider, baseUrl: preset.baseUrl, extraBody: {},
                         maxTokens: Math.min(Number(raw.maxTokens) || 16000, 32000), timeoutMs: 280_000 });
    } else {
      cfg = resolveLLM({ ...raw, timeoutMs: 280_000 });
    }
    if (cfg.provider === "fake") return NextResponse.json({ error: "the offline stand-in runs in the browser" }, { status: 400 });
    const out = await callModel(cfg, messages, apiKey, req.signal);
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof LLMError) {
      return NextResponse.json({ error: e.message, retryable: !!e.retryable, retryAfter: e.retryAfter, quota: !!e.quota },
                               { status: e.status && e.status >= 400 ? e.status : 502 });
    }
    return NextResponse.json({ error: (e as Error).message ?? "server error", retryable: true }, { status: 500 });
  }
}
