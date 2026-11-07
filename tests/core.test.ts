/** Run with: npm test   (Node's built-in test runner; no network, no key needed) */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { makeAsker, parseJson } from "../lib/ask";
import { DEFAULT_CONFIG, parseEpisodeList } from "../lib/config";
import { build, cleanIn, cleanOut, insideLine } from "../lib/cuts";
import { evaluate } from "../lib/evaluate";
import { resolveLLM } from "../lib/llm";
import { Show, fmtTs, getEp, loadShow, parseEpisode, tsToSec } from "../lib/parse";
import { runPipeline } from "../lib/pipeline";
import { buildFiles } from "../lib/report";

const ROOT = path.resolve(__dirname, "..");
const SAMPLE = path.join(ROOT, "public", "sample_show");
const sources = () => fs.readdirSync(SAMPLE).filter((f) => f.endsWith(".txt")).sort()
  .map((f) => ({ name: f, text: fs.readFileSync(path.join(SAMPLE, f), "utf8") }));
const sample = () => loadShow(sources(), "Sample");
const line = (show: Show, ep: number, text: string) => getEp(show, ep).lines.find((l) => l.text.includes(text))!;

test("timecodes", () => {
  assert.equal(tsToSec("01:02.50"), 62.5);
  assert.equal(tsToSec("1:00:00.0"), 3600);
  assert.equal(fmtTs(59.999), "01:00.00");
  assert.equal(fmtTs(62.5), "01:02.50");
});

test("parses the Kuku layout", async () => {
  const s = await sample();
  assert.deepEqual(s.episodes.map((e) => e.number), [1, 2, 3]);
  const ep = getEp(s, 1);
  assert.equal(ep.duration, 72);
  assert.equal(ep.warnings.length, 0);
  const w = line(s, 1, "Let me help you");
  assert.deepEqual([w.speaker, w.note, w.start, w.end], ["VANESSA", "Mocking", 13.8, 16.2]);
  assert.deepEqual(new Set(ep.events.map((e) => e.kind)), new Set(["SHOT", "ACTION", "LINE", "SFX"]));
});

test("parses a second, simpler layout", async () => {
  const ep = await parseEpisode(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "simple_layout.txt"), "utf8"), "simple_layout.txt");
  assert.equal(ep.parser, "simple");
  assert.equal(ep.number, 7);
  assert.equal(ep.events.length, 6);
  const l = ep.lines.find((x) => x.text.includes("never see your sister"))!;
  assert.equal(l.speaker, "MAN IN CAR");
  assert.equal(l.start, 5.5);
});

test("cut points never split a line", async () => {
  const s = await sample();
  const ep = getEp(s, 1);
  const hook = line(s, 1, "Let me help you");
  const tIn = cleanIn(ep, hook.start, hook.start - 2.75);
  assert.ok(tIn <= hook.start && !insideLine(ep, tIn));
  const cliff = line(s, 1, "That means the hotel");
  const tOut = cleanOut(ep, cliff.end, cliff.end + 3);
  assert.ok(tOut >= cliff.end && !insideLine(ep, tOut));
});

test("builds a valid promo from event IDs", async () => {
  const s = await sample();
  const h = line(s, 1, "Let me help you"), c = line(s, 1, "That means the hotel");
  const b = build(s, { segments: [{ ep: 1, startEvent: h.id, endEvent: c.id }], hook: { ep: 1, event: h.id }, cliff: { ep: 1, event: c.id } });
  assert.ok(b.ok, b.errors.join("; "));
  assert.ok(b.duration >= 20 && b.duration <= 60);
  assert.ok(b.hookOffset >= 0 && b.hookOffset <= 3);
});

test("rejects drafts that break the brief's rules", async () => {
  const s = await sample();
  const ep = getEp(s, 1);
  const first = ep.lines[0], last = ep.lines[ep.lines.length - 1];
  const tooLong = build(s, { segments: [{ ep: 1, startEvent: first.id, endEvent: last.id }], hook: { ep: 1, event: first.id }, cliff: { ep: 1, event: last.id } });
  assert.ok(!tooLong.ok && tooLong.errors.some((e) => e.includes("over 60")));
  const invented = build(s, { segments: [{ ep: 1, startEvent: "e999", endEvent: last.id }], hook: { ep: 1, event: "e999" }, cliff: { ep: 1, event: last.id } });
  assert.ok(!invented.ok && invented.errors.some((e) => e.includes("unknown event")));
  const h = line(s, 1, "I'm looking for Maya"), c = line(s, 1, "Arthur Aurelia?"), end = line(s, 1, "That means the hotel");
  const answer = line(s, 1, "left you everything");
  const showsAnswer = build(s, { segments: [{ ep: 1, startEvent: h.id, endEvent: end.id }], hook: { ep: 1, event: h.id },
                                  cliff: { ep: 1, event: c.id }, answeredBy: { ep: 1, event: answer.id } });
  assert.ok(!showsAnswer.ok);
});

test("moves the start so the hook lands in the first 3 seconds", async () => {
  const s = await sample();
  const start = line(s, 1, "You're working here"), h = line(s, 1, "Let me help you"), c = line(s, 1, "That means the hotel");
  const b = build(s, { segments: [{ ep: 1, startEvent: start.id, endEvent: c.id }], hook: { ep: 1, event: h.id }, cliff: { ep: 1, event: c.id } });
  assert.ok(b.ok && b.hookOffset <= 3 && b.fixes.length > 0);
});

test("parses messy model JSON and fills presets", () => {
  assert.deepEqual(parseJson('```json\n{"a": [1, 2,],}\n```'), { a: [1, 2] });
  assert.deepEqual(parseJson('Sure! {"ok": true} hope that helps'), { ok: true });
  const g = resolveLLM({ preset: "gemini" });
  assert.equal(g.provider, "openai_compatible");
  assert.ok(g.baseUrl.includes("generativelanguage"));
  assert.equal(resolveLLM({ preset: "anthropic", model: "x" }).provider, "anthropic");
  assert.deepEqual(parseEpisodeList("1-3,7", [1, 2, 3, 4, 5, 6, 7, 8]), [1, 2, 3, 7]);
});

test("offline end-to-end run produces checked, ranked promos and all files", async () => {
  const logs: any[] = [], raw: any[] = [];
  const ask = makeAsker({ model: "fake", cacheScope: "fake", rpm: 1e6, fake: true, send: async () => { throw new Error("no network"); },
                          onLog: (r) => logs.push(r), onRaw: (stage, tag, messages, reply, usage) => raw.push({ stage, tag, messages, reply, usage }) });
  const cfg = { ...DEFAULT_CONFIG, llm: { preset: "fake", concurrency: 4 } };
  const { result, show } = await runPipeline(sources(), cfg, { ask, model: "fake", logs, title: "Sample" });
  const good = result.promos.filter((p) => !p.duplicate_of);
  assert.ok(good.length > 0);
  assert.ok(good.every((p) => p.valid && Object.values(p.checks).every(Boolean)));
  assert.ok(good.every((p) => p.duration >= 20 && p.duration <= 60));
  assert.ok(good.some((p) => p.post_first === 1));
  assert.ok(result.stats.propose.sent_to_repair > 0, "repair path exercised");
  const files = buildFiles(result, Object.fromEntries(show.episodes.map((e) => [e.number, e.source])), logs, raw);
  for (const f of ["promos.json", "promos_ranked.csv", "cut_list.csv", "report.html", "run_log.json", "calls.jsonl"]) assert.ok(files[f], f);
  // a gold promo that overlaps the top pick counts as found
  const top = good[0].segments[0];
  const ev = evaluate(result, `episode,start,end,note\n${top.ep},${top.start_tc},${top.end_tc},same\n`) as any;
  assert.equal(ev.gold.found_by_tool, 1);
});

test("gold rows tolerate pasted ranges and mangled dashes", async () => {
  const { goldSpan } = await import("../lib/evaluate");
  assert.deepEqual(goldSpan("00:52.80\uFFFD00:55.80", "01:28.80\u201301:31.50"), [52.8, 91.5]);
  assert.deepEqual(goldSpan("01:15.20", "01:52.40"), [75.2, 112.4]);
});
