/**
 * Command line (same pipeline as the web app, run with Node):
 *
 *   npm run promos -- run <scripts folder|.zip|.txt> [--out runs/x] [--episodes 1-10] [--model gemini-3.8-flash]
 *                         [--preset gemini] [--judge-model ...] [--no-judge] [--no-stitch] [--baseline] [--fake]
 *                         [--rpm 8] [--concurrency 3]
 *   npm run promos -- check [--preset gemini] [--model ...]        one tiny uncached call: key, model, speed, tokens
 *   npm run promos -- transcripts <scripts> --out <dir>            readable transcripts (for a hand-picked gold set)
 *   npm run promos -- eval <run dir> [--gold gold.csv] [--review review.csv] [--top 10]
 *   npm run promos -- compare <run dir A> <run dir B> [--top 10]
 */
import fs from "node:fs";
import path from "node:path";
import { CacheEntry, CallLog, makeAsker } from "../lib/ask";
import { DEFAULT_CONFIG, mergeConfig } from "../lib/config";
import { compare, evaluate } from "../lib/evaluate";
import { LLMConfig, LLMError, callModel, resolveLLM } from "../lib/llm";
import { Source, fmtTs, guessTitle, label, loadShow, readZip } from "../lib/parse";
import { runPipeline } from "../lib/pipeline";
import type { Message } from "../lib/prompts";
import { buildFiles } from "../lib/report";
import type { RunResult } from "../lib/types";

const ROOT = path.resolve(__dirname, "..");

function loadEnv() {
  for (const p of [path.join(process.cwd(), ".env"), path.join(ROOT, ".env"), path.join(path.dirname(ROOT), ".env")]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

function args(argv: string[]) {
  const pos: string[] = [], flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[k] = argv[++i]; else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function readSources(p: string): Source[] {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    const out: Source[] = [];
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, f.name);
        if (f.isDirectory()) walk(full);
        else if (f.name.toLowerCase().endsWith(".txt") && !f.name.startsWith(".")) out.push({ name: f.name, text: fs.readFileSync(full, "utf8") });
      }
    };
    walk(p);
    return out;
  }
  if (p.toLowerCase().endsWith(".zip")) return readZip(new Uint8Array(fs.readFileSync(p)));
  return [{ name: path.basename(p), text: fs.readFileSync(p, "utf8") }];
}

function fileCache(dir: string) {
  const file = (k: string) => path.join(dir, k.slice(0, 2), `${k}.json`);
  return {
    async get(k: string) { return fs.existsSync(file(k)) ? (JSON.parse(fs.readFileSync(file(k), "utf8")) as CacheEntry) : null; },
    async set(k: string, v: CacheEntry) { fs.mkdirSync(path.dirname(file(k)), { recursive: true }); fs.writeFileSync(file(k), JSON.stringify(v)); },
  };
}

function llmFromFlags(base: Partial<LLMConfig>, flags: Record<string, string | boolean>, prefix = ""): Partial<LLMConfig> {
  const out = { ...base };
  const preset = flags[`${prefix}preset`], model = flags[`${prefix}model`];
  if (typeof preset === "string") { out.preset = preset; if (typeof model !== "string") delete out.model; delete out.baseUrl; delete out.apiKeyEnv; delete out.provider; }
  if (typeof model === "string") out.model = model;
  for (const k of ["rpm", "concurrency"] as const) {
    const v = Number(flags[`${prefix}${k}`]);
    if (flags[`${prefix}${k}`] !== undefined && v > 0) out[k] = v;
  }
  return out;
}

const short = (s: string, n = 200) => s.replace(/\s+/g, " ").slice(0, n);

function asker(cfg: LLMConfig, logs: CallLog[], raw: any[], fake: boolean) {
  const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] ?? "" : "";
  if (!fake && !key && !cfg.baseUrl.includes("localhost")) {
    throw new Error(`No API key: put ${cfg.apiKeyEnv}=... in a .env file (or the environment).`);
  }
  const name = `${cfg.preset ?? cfg.provider}:${cfg.model}`;
  return {
    name,
    ask: makeAsker({
      model: name, rpm: fake ? 1e6 : cfg.rpm, maxAttempts: cfg.maxAttempts, fake,
      cacheScope: JSON.stringify([cfg.provider, cfg.baseUrl, cfg.model, cfg.temperature, cfg.maxTokens, cfg.extraBody]),
      cache: fake ? undefined : fileCache(path.join(process.cwd(), ".cache")),
      send: (m: Message[], signal?: AbortSignal) => callModel(cfg, m, key, signal),
      onLog: (r) => logs.push(r),
      onRaw: (stage, tag, messages, reply, usage) => raw.push({ stage, tag, messages, reply, usage }),
      onRetry: (r) => console.error(`  retry: ${r.stage} ${r.tag} attempt ${r.attempt}/${r.maxAttempts} failed, waiting ${r.waitS} s: ${short(r.error)}`),
    }),
  };
}

async function cmdRun(pos: string[], flags: Record<string, string | boolean>) {
  const input = pos[0];
  if (!input) throw new Error("usage: run <scripts folder|.zip|.txt>");
  let cfg = DEFAULT_CONFIG;
  if (typeof flags.config === "string") cfg = mergeConfig(cfg, JSON.parse(fs.readFileSync(flags.config, "utf8")));
  const fake = !!flags.fake;
  cfg = mergeConfig(cfg, {
    llm: fake ? { preset: "fake" } as any : llmFromFlags(cfg.llm, flags),
    judgeLlm: llmFromFlags(cfg.judgeLlm, flags, "judge-"),
    judge: flags["no-judge"] ? { enabled: false } : {},
    stitch: flags["no-stitch"] ? { enabled: false } : {},
    proposer: flags.baseline ? { mode: "baseline" } : {},
  });
  if (fake) cfg.llm = { preset: "fake", concurrency: 4 };
  const llmCfg = resolveLLM(cfg.llm);
  const logs: CallLog[] = [], raw: any[] = [];
  const main = asker(llmCfg, logs, raw, fake);
  const hasJudge = !fake && Object.keys(cfg.judgeLlm ?? {}).length > 0;
  const judge = hasJudge ? asker(resolveLLM({ ...cfg.llm, ...cfg.judgeLlm }), logs, raw, false) : null;
  const slug = guessTitle(input).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const out = typeof flags.out === "string" ? flags.out : path.join("runs", `${slug}-${llmCfg.model.replace(/\//g, "-")}${flags.baseline ? "-baseline" : ""}-${stamp}`);
  console.log(`Promo finder -> ${out}\n  model: ${main.name}${judge ? `  judge: ${judge.name}` : ""}`);
  let last = 0;
  const sources = readSources(input);
  const { result, show } = await runPipeline(sources, cfg, {
    ask: main.ask, judgeAsk: judge?.ask, model: main.name, judgeModel: judge?.name, logs,
    episodes: typeof flags.episodes === "string" ? flags.episodes : undefined, title: guessTitle(input),
    progress: (stage, done, total) => {
      if (done === 0 || done === total || Date.now() - last > 2000) { last = Date.now(); console.log(`  [${stage}] ${done}/${total}`); }
    },
  });
  const files = buildFiles(result, Object.fromEntries(show.episodes.map((e) => [e.number, e.source])), logs, raw);
  fs.rmSync(path.join(out, "llm_raw"), { recursive: true, force: true });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(out, name)), { recursive: true });
    fs.writeFileSync(path.join(out, name), content);
  }
  const u = result.usage.total;
  console.log(`\nDone in ${Math.round(result.runtime_s)} s: ${result.promos.filter((p) => !p.duplicate_of).length} promos, ${u.calls} model calls `
    + `(${u.cache_hits} cached), ${u.prompt_tokens.toLocaleString("en")} in / ${u.completion_tokens.toLocaleString("en")} out tokens`);
  for (const p of result.promos.filter((p) => p.post_first).sort((a, b) => a.post_first! - b.post_first!)) {
    console.log(`  ${p.post_first}. ${p.id.padEnd(7)} ${p.segments.map((s) => `Ep${s.ep} ${s.start_tc}-${s.end_tc}`).join(" + ")}  [${p.score}]  ${p.hook.text.slice(0, 60)}`);
  }
  if (result.stopped) console.log(`\n${result.stopped}`);
  for (const n of result.notes.slice(0, 10)) console.log("  note:", n.slice(0, 300));
  console.log(`\nOpen ${path.join(out, "report.html")}`);
  process.exitCode = result.stopped ? 2 : 0;
}

async function cmdCheck(flags: Record<string, string | boolean>) {
  // One direct call: no cache, no retries, so what you see is exactly what the API did.
  const cfg = resolveLLM(llmFromFlags(DEFAULT_CONFIG.llm, flags));
  const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] ?? "" : "";
  if (!key && !cfg.baseUrl.includes("localhost")) throw new Error(`No API key: put ${cfg.apiKeyEnv}=... in a .env file (or the environment).`);
  const name = `${cfg.preset ?? cfg.provider}:${cfg.model}`;
  console.log(`${name}: sending one test call...`);
  const t0 = Date.now();
  try {
    const { text, usage } = await callModel(cfg, [{ role: "user", content: `Reply with exactly this JSON: {"ok": true, "n": ${t0}}` }], key);
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    const ok = /"ok"\s*:\s*true/.test(text);
    console.log(`${name}: ${ok ? "ok" : `unexpected reply: ${short(text)}`} in ${s} s`
      + ` (tokens: ${usage.prompt_tokens} in, ${usage.completion_tokens} out${usage.reasoning_tokens ? `, of which ${usage.reasoning_tokens} thinking` : ""})`);
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    const err = e as LLMError;
    console.log(`${name}: FAILED after ${((Date.now() - t0) / 1000).toFixed(1)} s\n  ${short(err.message, 600)}`);
    if (err.quota) console.log("  The daily quota for this model is used up. It resets at midnight Pacific time (1:30 pm IST).");
    else if (err.retryable) console.log("  This is a temporary error (rate limit or overload). Real runs wait and retry these automatically.");
    process.exitCode = 1;
  }
}

async function cmdTranscripts(pos: string[], flags: Record<string, string | boolean>) {
  const show = await loadShow(readSources(pos[0]), guessTitle(pos[0]));
  const out = String(flags.out ?? "transcripts");
  fs.mkdirSync(out, { recursive: true });
  for (const ep of show.episodes) {
    const rows = [`# Episode ${ep.number} (${fmtTs(ep.duration)})`, "", ep.logline, "", ...ep.events.map((e) => `${fmtTs(e.start)}-${fmtTs(e.end)}  ${label(e)}`)];
    fs.writeFileSync(path.join(out, `ep${String(ep.number).padStart(3, "0")}.txt`), rows.join("\n") + "\n");
  }
  console.log(`wrote ${show.episodes.length} transcripts to ${out}`);
}

const loadRun = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "promos.json"), "utf8")) as RunResult;

async function main() {
  loadEnv();
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = args(rest);
  const top = Number(flags.top ?? 10);
  if (cmd === "run") return cmdRun(pos, flags);
  if (cmd === "check") return cmdCheck(flags);
  if (cmd === "transcripts") return cmdTranscripts(pos, flags);
  if (cmd === "eval") {
    const rep = evaluate(loadRun(pos[0]), typeof flags.gold === "string" ? fs.readFileSync(flags.gold, "utf8") : undefined,
                         typeof flags.review === "string" ? fs.readFileSync(flags.review, "utf8") : undefined, top);
    fs.writeFileSync(path.join(pos[0], "eval.json"), JSON.stringify(rep, null, 1));
    return console.log(JSON.stringify(rep, null, 1));
  }
  if (cmd === "compare") return console.log(JSON.stringify(compare(loadRun(pos[0]), loadRun(pos[1]), top), null, 1));
  console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*\*?/, "").replace(/^ \* ?/gm, ""));
}

main().catch((e) => { console.error(`Error: ${e instanceof Error ? e.message : e}`); process.exitCode = 1; });
