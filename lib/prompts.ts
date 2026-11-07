/**
 * Every prompt in one place. The model only ever sees and returns event IDs;
 * code owns all timestamps (see cuts.ts).
 *
 * Stages: bible -> propose (per episode) -> repair (only failures) -> stitch
 * (across episodes) -> judge (cold viewer, one clip at a time).
 */
import type { Segment } from "./cuts";
import { eventsIn } from "./cuts";
import type { Episode, Show } from "./parse";
import { getEp, label } from "./parse";

export type Message = { role: "system" | "user" | "assistant"; content: string };

export const HOOK_TYPES = ["violence", "betrayal", "humiliation", "reveal", "shocking_line", "threat",
  "power_reversal", "romance", "rescue", "other"];

export interface Bible { premise?: string; characters?: { name?: string; labels?: string[]; who?: string }[]; arcs?: string[] }

/** MM:SS.s, compact for prompts. */
export function t1(x: number): string {
  const ds = Math.round(x * 10);
  return `${String(Math.floor(ds / 600)).padStart(2, "0")}:${((ds % 600) / 10).toFixed(1).padStart(4, "0")}`;
}

export function transcript(ep: Episode): string {
  const out: string[] = [];
  let scene: number | null = null;
  for (const e of ep.events) {
    if (e.scene !== scene) {
      scene = e.scene;
      const sc = ep.scenes.find((s) => s.n === scene);
      if (sc?.heading) out.push(`-- SCENE ${sc.n}: ${sc.heading} --`);
    }
    out.push(`${e.id} ${t1(e.start)}-${t1(e.end)} ${label(e)}`);
  }
  return out.join("\n");
}

function charactersBlock(bible: Bible): string {
  const rows = (bible.characters ?? []).slice(0, 15).map((c) =>
    `- ${c.name ?? "?"}: ${(c.labels ?? []).slice(0, 6).join(", ")} — ${c.who ?? ""}`);
  return rows.join("\n") || "- (not available)";
}

// ------------------------------------------------------------------ bible

export function bibleMessages(show: Show): Message[] {
  const rows = show.episodes.map((ep) => {
    const counts = new Map<string, number>();
    for (const l of ep.lines) counts.set(l.speaker, (counts.get(l.speaker) ?? 0) + 1);
    const spk = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} x${v}`).join(", ");
    return `Ep ${ep.number} | ${spk} | ${ep.logline}`;
  });
  const user = `SHOW: ${show.title}
For each episode: the speaker labels used in its script (with counts) and its logline.
Labels are inconsistent: one person can be a name in one episode and a description
(for example "THE STRANGER" or "OFF-SCREEN VOICE") in another.

${rows.join("\n")}

Return JSON:
{
  "premise": "2-3 sentences: the series' core hook, as a trailer would pitch it",
  "characters": [{"name": "...", "labels": ["SCRIPT LABEL", "..."], "who": "max 12 words: role and relationship"}],
  "arcs": ["Eps 1-5: ...", "..."]
}
At most 15 characters (main ones first) and at most 8 arc lines.`;
  return [{ role: "system", content: "You write short series bibles for a promo editing team. Return only JSON." },
          { role: "user", content: user }];
}

// ------------------------------------------------------------------ propose

export const PROPOSE_SYSTEM = `You are a promo editor for vertical microdrama apps (ReelShort, DramaBox style).
From one episode's timed screenplay you pick the stretches that work as 20-60 second promo
clips for TikTok, Instagram Reels and YouTube Shorts. A promo has one job: make a stranger
who is scrolling stop, understand the situation at once, and need to know what happens next.

What works in this genre
- Hooks (first 3 seconds): a slap, strike, shove, blood, fire or explosion; a public humiliation;
  a betrayal revealed; a secret identity revealed; a cruel or shocking line; a threat or
  ultimatum; the underdog turning the tables; a dramatic entrance or rescue; a forbidden kiss.
- Weak openings: establishing shots, walking, small talk, exposition, a reaction to something
  the viewer hasn't seen.
- Cliffhangers (last seconds): cut at the peak of an unanswered question: a threat about to be
  carried out, a reveal half made, a decision not yet given, someone walking in at the worst
  moment, a confrontation at its height. Cut right after the line or action that raises the
  question, before anyone answers it.
- Standalone: inside the clip a stranger must get who is wronged, by whom, and what is at stake.
  Avoid clips that hinge on names, objects or events the clip itself doesn't show.

Hard rules (code checks every promo and sends failures back to you)
1. Refer to the transcript only by event IDs (like e014). Never write timestamps.
2. A promo is 1-3 segments from this episode, in story order, not overlapping. Most promos are
   one continuous segment; use 2-3 segments only to skip a slow middle. Each segment >= 3 s.
3. Total length 20-60 seconds; aim for 25-50. Add up the event times to check.
4. hook_event must start within the first 3 seconds: the first segment starts on the hook event
   or at most 2 seconds before it.
5. cliffhanger_event is the last line or action of the last segment (holding up to ~2 s on a
   reaction shot after it is fine).
6. If the cliffhanger's question is answered later in this episode, give the event that answers
   it as answered_by; the clip must end before it. If it is answered only in a later episode,
   answered_by is null.
Return only JSON.`;

export function proposeMessages(show: Show, ep: Episode, bible: Bible, nPromos: number, nMoments: number): Message[] {
  const i = show.episodes.indexOf(ep);
  const prev = i > 0 ? show.episodes[i - 1].logline : "none (this is the first episode in the input)";
  const next = i + 1 < show.episodes.length ? show.episodes[i + 1].logline : "none (last episode in the input)";
  const user = `SHOW: ${show.title}
PREMISE (for you only; a promo viewer knows none of this): ${bible.premise ?? ""}
CHARACTERS (script labels vary; each row is one person):
${charactersBlock(bible)}
PREVIOUS EPISODE: ${prev}
NEXT EPISODE: ${next}

EPISODE ${ep.number} (length ${t1(ep.duration)})
Logline: ${ep.logline}
Continuity: ${ep.notes}

TRANSCRIPT: id start-end TYPE text. SHOT = what the camera shows, ACTION = what happens,
LINE = dialogue, SFX = sound.
${transcript(ep)}

TASK
1. "moments": up to ${nMoments} short clip-able moments (3-20 s each) that could be cut into a
   trailer with moments from other episodes: strongest hooks, reveals and cliffhangers.
2. "promos": the ${nPromos} best promos in this episode (fewer if only one is genuinely strong).
   Different promos should be built around different moments.

JSON format:
{
  "moments": [
    {"id": "m1", "start_event": "e012", "end_event": "e019",
      "kind": "hook | reveal | cliffhanger | payoff",
      "hook_event": "event that grabs attention in the moment's first 3 s, or null",
      "cliffhanger_event": "event the moment ends on if it leaves an open question, or null",
      "answered_by": "event id that answers that question in this episode, or null",
      "label": "max 12 words: what happens, with character names",
      "strength": 1}
  ],
  "promos": [
    {"segments": [{"start_event": "e012", "end_event": "e040"}],
      "hook_event": "e013",
      "hook_type": "one of: ${HOOK_TYPES.join(", ")}",
      "hook": "max 15 words: what happens in the first 3 seconds",
      "cliffhanger_event": "e040",
      "answered_by": null,
      "cliffhanger": "max 15 words: the unanswered question the viewer is left with",
      "why": "one line: why this promo works",
      "standalone_risk": "what a new viewer might not get, or none",
      "hook_strength": 1,
      "cliffhanger_strength": 1}
  ]
}
Strengths are 1-10.`;
  return [{ role: "system", content: PROPOSE_SYSTEM }, { role: "user", content: user }];
}

/** Multi-turn: the model sees its own answer plus what the checks found. */
export function repairMessages(base: Message[], reply: unknown, failures: [number, string[]][]): Message[] {
  const lines = failures.map(([i, errs]) => `- promos[${i}]: ${errs.join("; ")}`).join("\n");
  const ask = `Code checked your promos. These failed:
${lines}

Return corrected versions of ONLY these promos as {"promos": [...]} in the same format.
You may move the segments, pick another hook or cliffhanger, or split a long stretch into 2-3
segments that skip a slow middle. Leave a promo out if it can't be fixed. Recompute every
length from the event times before answering.`;
  return [...base, { role: "assistant", content: JSON.stringify(reply) }, { role: "user", content: ask }];
}

// ------------------------------------------------------------------ stitch

export const STITCH_SYSTEM = `You are a promo editor for vertical microdrama apps. You build trailer-style
promos by joining 2-3 short moments from different episodes of one show, the way ReelShort and
DramaBox ads often sell a show's premise in under a minute.

Rules (code checks them)
1. Use only moment IDs from the list.
2. 2-3 moments in story order (earlier episodes first), from at least 2 different episodes.
3. The first moment must be marked HOOK: it opens the promo.
4. The last moment must be marked CLIFF: the promo ends on its open question.
5. Total 20-60 seconds (aim for 30-50); each moment's length is given.
6. Joined, the moments must tell one simple story a stranger can follow (who she is, what was
   done to her, the twist). Don't join moments that need explaining in between.
Return only JSON.`;

export interface Moment {
  id: string; ep: number; startEvent: string; endEvent: string; hookEvent: string | null;
  cliffhangerEvent: string | null; answeredBy: string | null; hasHook: boolean; hasCliff: boolean;
  kind: string; label: string; strength: number; start: number; end: number; duration: number; keyLine: string;
}

export function stitchMessages(show: Show, bible: Bible, moments: Moment[], n: number): Message[] {
  const rows = moments.map((m) => {
    const marks = [m.hasHook ? "HOOK" : "", m.hasCliff ? "CLIFF" : ""].filter(Boolean).join("+") || "-";
    return `${m.id} | ep ${m.ep} | ${m.duration.toFixed(1)} s | ${marks} | ${m.label} | ${m.keyLine}`;
  });
  const user = `SHOW: ${show.title}
PREMISE (for you only): ${bible.premise ?? ""}
CHARACTERS:
${charactersBlock(bible)}

MOMENTS (id | episode | length | marks | what happens | key line):
${rows.join("\n")}

Propose up to ${n} promos, each telling a different mini-story.
JSON: {"promos": [{"moments": ["E01.m1", "E03.m2"], "hook_type": "one of: ${HOOK_TYPES.join(", ")}",
"hook": "max 15 words", "cliffhanger": "max 15 words: the open question at the end",
"why": "one line", "standalone_risk": "or none", "hook_strength": 1, "cliffhanger_strength": 1}]}
Strengths are 1-10.`;
  return [{ role: "system", content: STITCH_SYSTEM }, { role: "user", content: user }];
}

// ------------------------------------------------------------------ judge

export const JUDGE_SYSTEM = `You are a typical viewer scrolling TikTok or Instagram Reels. You have never heard of
this show and know nothing about its characters. You will read the script of one short promo
clip: what is on screen (SHOT, ACTION), what is said (LINE) and heard (SFX), with times from
the start of the clip. "== CUT ==" marks a jump to another moment. Judge only what is in the
clip. Be strict: most clips are average; give 9-10 only to clips you would really stop for.
Return only JSON.`;

export function clipScript(show: Show, segments: { ep: number; start: number; end: number }[]): string {
  const out: string[] = [];
  let offset = 0;
  segments.forEach((s, i) => {
    if (i) out.push("== CUT ==");
    for (const e of eventsIn(getEp(show, s.ep), s.start, s.end)) {
      out.push(`[${t1(Math.max(e.start, s.start) - s.start + offset)}] ${label(e)}`);
    }
    offset += s.end - s.start;
  });
  return out.join("\n");
}

export function judgeMessages(show: Show, segments: Pick<Segment, "ep" | "start" | "end">[]): Message[] {
  const dur = segments.reduce((a, s) => a + (s.end - s.start), 0);
  const user = `CLIP (${dur.toFixed(1)} s)
${clipScript(show, segments)}

Answer as this new viewer, in JSON:
{
  "first_3_seconds": "what you see and hear in the first 3 seconds",
  "hook_score": 0,
  "story": "one sentence: who these people are and what is going on, as you understood it",
  "open_question": "the question you are left with at the end, or none",
  "cliffhanger_score": 0,
  "standalone_score": 0,
  "confusing": ["names, objects or events you did not understand"],
  "would_watch_next": false,
  "issues": ["anything that would make you scroll past"]
}
Scores are 0-10:
- hook_score, first 3 seconds only. 9-10: instant shock (a strike, a public betrayal, a brutal
  line, a big reveal). 6-8: clear tension right away. 3-5: mildly interesting. 0-2: setup,
  nothing happening yet.
- cliffhanger_score, the ending. 9-10: cuts at the peak of a question you badly want answered.
  6-8: a clear open question. 3-5: tension mostly released, or vague. 0-2: resolved or calm.
- standalone_score. 9-10: everything you need is in the clip. 6-8: small unknowns that don't
  matter. 3-5: you are missing context. 0-2: you can't follow it.`;
  return [{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: user }];
}

// ------------------------------------------------------------------ parse fallback

export function parseMessages(text: string): Message[] {
  const user = `Screenplay excerpt:
<<<
${text}
>>>
Return {"events": [{"start": "timestamp exactly as written", "end": "timestamp as written, or same as start",
"kind": "SHOT | ACTION | LINE | SFX", "speaker": "for LINE only", "text": "..."}]}
Skip anything that has no timestamp in the text.`;
  return [{ role: "system", content: "You convert screenplay text into timed events. Copy timestamps exactly as written; never invent or compute a time. Return only JSON." },
          { role: "user", content: user }];
}
