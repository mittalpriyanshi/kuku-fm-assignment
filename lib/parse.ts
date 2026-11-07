/**
 * Screenplay parser: timed microdrama scripts -> structured episodes.
 *
 * Plain code, not AI: the scripts are regular, and every timestamp we output
 * must be exact, so a model never reads or writes a time.
 *
 * Layouts:
 *  1. Kuku layout:  **LABEL (notes):** / Start: (MM:SS.ss) | End: (MM:SS.ss) / text
 *  2. Simple lines: [00:12.5 - 00:15.0] NAME: text   (also "-->" or "to")
 *  3. Anything else: optional AI fallback (llmParse). Its timestamps are kept
 *     only if they literally appear in the source text.
 */
import { unzipSync, strFromU8 } from "fflate";
import type { AskFn } from "./ask";
import { parseMessages } from "./prompts";

export type Kind = "SHOT" | "ACTION" | "LINE" | "SFX" | "TEXT";

export interface Event {
  id: string; // e001, e002 ... local to the episode, in time order
  ep: number;
  scene: number;
  kind: Kind;
  speaker: string; // dialogue only
  note: string; // parentheticals, e.g. "Cold, Commanding" or "O.S.; Firm"
  text: string;
  start: number; // seconds from the start of the episode
  end: number;
}

export interface Scene { n: number; heading: string; start: number; end: number }

export interface Episode {
  number: number;
  source: string;
  logline: string;
  notes: string;
  scenes: Scene[];
  events: Event[];
  duration: number;
  warnings: string[];
  parser: "kuku" | "simple" | "llm";
  // derived by indexEpisode():
  byId: Record<string, Event>;
  lines: Event[];
  cuts: number[]; // camera-cut times, the clean places to start or end a clip
}

export interface Show { title: string; episodes: Episode[] }

export type Source = { name: string; text: string };

export const EPS = 0.05; // seconds of tolerance when comparing times
const TS = String.raw`(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)`;

const NON_DIALOGUE: Record<string, Kind> = {
  CAMERA: "SHOT", SHOT: "SHOT", ACTION: "ACTION", "SOUND FX": "SFX", SFX: "SFX", SOUND: "SFX",
  MUSIC: "SFX", "TEXT ON SCREEN": "TEXT", SUPER: "TEXT", TITLE: "TEXT", TRANSITION: "SHOT",
};

export function tsToSec(s: string): number {
  let sec = 0;
  for (const part of s.trim().split(":")) sec = sec * 60 + parseFloat(part);
  return Math.round(sec * 1000) / 1000;
}

/** Seconds -> MM:SS.ss (same style as the scripts). */
export function fmtTs(x: number): string {
  const cs = Math.round(Math.max(x, 0) * 100);
  const m = Math.floor(cs / 6000);
  const s = (cs % 6000) / 100;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

/** One readable line: 'LINE SPEAKER (notes): "text"' or 'SHOT text'. */
export function label(e: Event): string {
  if (e.kind === "LINE") return `LINE ${e.speaker}${e.note ? ` (${e.note})` : ""}: "${e.text}"`;
  return `${e.kind} ${e.text}`;
}

export function getEp(show: Show, n: number): Episode {
  const ep = show.episodes.find((e) => e.number === n);
  if (!ep) throw new Error(`episode ${n} not found`);
  return ep;
}

function emptyEpisode(source: string, parser: Episode["parser"]): Episode {
  return { number: 0, source, logline: "", notes: "", scenes: [], events: [], duration: 0, warnings: [], parser,
           byId: {}, lines: [], cuts: [] };
}

type Raw = Omit<Event, "id" | "ep">;

function finish(ep: Episode, raw: Raw[]): Episode {
  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const width = Math.max(3, String(raw.length).length);
  ep.events = raw.map((r, i) => ({ id: `e${String(i + 1).padStart(width, "0")}`, ep: ep.number, ...r }));
  const ends = [...ep.events.map((e) => e.end), ...ep.scenes.map((s) => s.end)];
  ep.duration = ends.length ? Math.round(Math.max(...ends) * 100) / 100 : 0;
  if (!ep.scenes.length && ep.events.length) ep.scenes = [{ n: 1, heading: "", start: 0, end: ep.duration }];
  return indexEpisode(ep);
}

export function indexEpisode(ep: Episode): Episode {
  ep.byId = Object.fromEntries(ep.events.map((e) => [e.id, e]));
  ep.lines = ep.events.filter((e) => e.kind === "LINE");
  const cuts = new Set<number>([0, round2(ep.duration)]);
  for (const e of ep.events) if (e.kind === "SHOT") { cuts.add(round2(e.start)); cuts.add(round2(e.end)); }
  ep.cuts = [...cuts].filter((c) => c >= 0 && c <= ep.duration + EPS).sort((a, b) => a - b);
  return ep;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

// ------------------------------------------------------------------ layout 1

const H_FIELD = /^(EPISODE NUMBER|EPISODE LOGLINE|CONTINUITY NOTES|EPISODE TITLE)\s*:\s*(.*)$/i;
const SCENE_NO = /^SCENE\s+(\d+)\s*$/i;
const SCENE_HEAD = /^Scene heading\s*:\s*(.*)$/i;
const SCENE_START = new RegExp(String.raw`^Scene start\s*:\s*` + TS, "i");
const SCENE_END = new RegExp(String.raw`^Scene end\s*:\s*` + TS, "i");
const EL_HEAD = /^\*\*(.+?)\*\*\s*:?\s*$/;
const TIMES = new RegExp(String.raw`Start\s*:\s*\(?\s*` + TS + String.raw`\s*\)?\s*\|\s*End\s*:\s*\(?\s*` + TS + String.raw`\s*\)?`, "i");

function splitLabel(lbl: string): { kind: Kind; speaker: string; note: string } {
  const clean = lbl.trim().replace(/:+$/, "").trim();
  const base = clean.split("(")[0].trim();
  const note = [...clean.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].trim()).join("; ");
  const kind = NON_DIALOGUE[base.toUpperCase()] ?? "LINE";
  return { kind, speaker: kind === "LINE" ? base : "", note };
}

function cleanText(text: string, kind: Kind): string {
  let t = text.split(/\s+/).join(" ").trim();
  if (kind === "LINE" && t.length >= 2 && `"“`.includes(t[0]) && `"”`.includes(t[t.length - 1])) t = t.slice(1, -1).trim();
  return t;
}

function headerField(ep: Episode, line: string): boolean {
  const m = line.match(H_FIELD);
  if (!m) return false;
  const key = m[1].toUpperCase();
  const val = m[2].trim();
  if (key === "EPISODE NUMBER") ep.number = parseInt(val.match(/\d+/)?.[0] ?? "0", 10);
  else if (key === "EPISODE LOGLINE") ep.logline = val;
  else if (key === "CONTINUITY NOTES") ep.notes = val;
  return true;
}

export function parseKuku(text: string, source = ""): Episode {
  const ep = emptyEpisode(source, "kuku");
  const raw: Raw[] = [];
  let scene: Scene = { n: 0, heading: "", start: 0, end: 0 };
  let cur: { label: string; start: number | null; end: number | null; text: string[] } | null = null;

  const flush = () => {
    if (!cur) return;
    if (cur.start === null || cur.end === null) {
      ep.warnings.push(`skipped '${cur.label}' (no Start/End line)`);
    } else {
      const { kind, speaker, note } = splitLabel(cur.label);
      let end = cur.end;
      if (end < cur.start) {
        ep.warnings.push(`end before start at ${fmtTs(cur.start)} (${cur.label}); end set to start`);
        end = cur.start;
      }
      raw.push({ scene: scene.n, kind, speaker, note, text: cleanText(cur.text.join(" "), kind), start: cur.start, end });
    }
    cur = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    if (headerField(ep, s)) continue;
    let m: RegExpMatchArray | null;
    if ((m = s.match(SCENE_NO))) { flush(); scene = { n: parseInt(m[1], 10), heading: "", start: 0, end: 0 }; ep.scenes.push(scene); continue; }
    if ((m = s.match(SCENE_HEAD))) { flush(); scene.heading = m[1].trim(); continue; }
    if ((m = s.match(SCENE_START))) { flush(); scene.start = tsToSec(m[1]); continue; }
    if ((m = s.match(SCENE_END))) { flush(); scene.end = tsToSec(m[1]); continue; }
    if (s.startsWith("---") || /^actions and dialogue/i.test(s)) { flush(); continue; }
    if ((m = s.match(EL_HEAD))) { flush(); cur = { label: m[1], start: null, end: null, text: [] }; continue; }
    if (cur) {
      const c = cur as { label: string; start: number | null; end: number | null; text: string[] };
      if (c.start === null && (m = s.match(TIMES))) { c.start = tsToSec(m[1]); c.end = tsToSec(m[2]); }
      else if (c.start !== null) c.text.push(s);
    }
  }
  flush();
  return finish(ep, raw);
}

// ------------------------------------------------------------------ layout 2

const SIMPLE = new RegExp(String.raw`^\s*\[?\s*` + TS + String.raw`\s*(?:-|–|—|to|-->)\s*` + TS + String.raw`\s*\]?\s*[:|]?\s*(.+)$`, "i");
const SIMPLE_KIND = /^(CAMERA|SHOT|ACTION|SFX|SOUND FX|SOUND|MUSIC)\s*:\s*(.*)$/i;
const SIMPLE_LINE = /^([A-Z][A-Z0-9 .'\-]{1,40}?)\s*(\([^)]*\))?\s*:\s*(.+)$/;

export function parseSimple(text: string, source = ""): Episode {
  const ep = emptyEpisode(source, "simple");
  const raw: Raw[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(SIMPLE);
    if (!m) { headerField(ep, line.trim()); continue; }
    const start = tsToSec(m[1]);
    const end = Math.max(tsToSec(m[2]), start);
    const rest = m[3].trim();
    let k: RegExpMatchArray | null;
    if ((k = rest.match(SIMPLE_KIND))) {
      raw.push({ scene: 1, kind: NON_DIALOGUE[k[1].toUpperCase()] ?? "ACTION", speaker: "", note: "", text: k[2].trim(), start, end });
    } else if ((k = rest.match(SIMPLE_LINE))) {
      raw.push({ scene: 1, kind: "LINE", speaker: k[1].trim(), note: (k[2] ?? "").replace(/[()]/g, "").trim(),
                 text: cleanText(k[3], "LINE"), start, end });
    } else {
      raw.push({ scene: 1, kind: "ACTION", speaker: "", note: "", text: rest, start, end });
    }
  }
  return finish(ep, raw);
}

// ------------------------------------------------------------------ AI fallback

/** Last resort for an unknown layout. The model copies timestamps; code keeps an
 *  event only if both of its times literally appear in the source text. */
export async function llmParse(text: string, source: string, ask: AskFn, number = 0): Promise<Episode> {
  const present = new Set([...text.matchAll(new RegExp(TS, "g"))].map((m) => round2(tsToSec(m[1]))));
  const groups: string[] = [];
  let buf = "";
  for (const chunk of text.split(/\n\s*\n(?=\S)/)) {
    if (buf && buf.length + chunk.length > 9000) { groups.push(buf); buf = ""; }
    buf += chunk + "\n\n";
  }
  if (buf.trim()) groups.push(buf);
  const raw: Raw[] = [];
  let dropped = 0;
  for (let i = 0; i < groups.length; i++) {
    const out = await ask(parseMessages(groups[i]), { stage: "parse_fallback", tag: `${source}#${i}` });
    for (const ev of (out?.events ?? []) as any[]) {
      const sStr = String(ev?.start ?? ""), eStr = String(ev?.end || ev?.start || "");
      if (!/\d:\d\d/.test(sStr) || !/\d:\d\d/.test(eStr)) { dropped++; continue; }
      const s = tsToSec(sStr), e = tsToSec(eStr);
      if (!present.has(round2(s)) || !present.has(round2(e))) { dropped++; continue; }
      const kind = (["SHOT", "ACTION", "LINE", "SFX", "TEXT"].includes(String(ev.kind).toUpperCase())
        ? String(ev.kind).toUpperCase() : "ACTION") as Kind;
      raw.push({ scene: 1, kind, speaker: kind === "LINE" ? String(ev.speaker ?? "") : "", note: "",
                 text: String(ev.text ?? "").trim(), start: s, end: Math.max(s, e) });
    }
  }
  const ep = emptyEpisode(source, "llm");
  ep.number = number;
  if (dropped) ep.warnings.push(`AI parser: dropped ${dropped} events whose timestamps are not in the source`);
  return finish(ep, raw);
}

// ------------------------------------------------------------------ loading

export async function parseEpisode(text: string, source = "", ask?: AskFn): Promise<Episode> {
  let ep = parseKuku(text, source);
  if (ep.events.length < 3) {
    const alt = parseSimple(text, source);
    if (alt.events.length > ep.events.length) {
      alt.number = alt.number || ep.number;
      alt.logline = alt.logline || ep.logline;
      ep = alt;
    }
  }
  if (ep.events.length < 3 && ask) ep = await llmParse(text, source, ask, ep.number);
  if (!ep.number) ep.number = parseInt(source.replace(/^.*[\\/]/, "").match(/\d+/)?.[0] ?? "0", 10);
  for (const e of ep.events) e.ep = ep.number;
  return ep;
}

export async function loadShow(sources: Source[], title = "Untitled show", ask?: AskFn): Promise<Show> {
  const eps: Episode[] = [];
  for (const s of sources) {
    const ep = await parseEpisode(s.text, s.name, ask);
    if (ep.events.length) eps.push(ep);
  }
  eps.sort((a, b) => a.number - b.number);
  const seen = new Set<number>();
  for (const e of eps) {
    if (seen.has(e.number)) e.warnings.push(`duplicate episode number ${e.number}`);
    seen.add(e.number);
  }
  return { title, episodes: eps };
}

/** .txt files inside a .zip (folders and macOS junk ignored). */
export function readZip(bytes: Uint8Array): Source[] {
  const files = unzipSync(bytes);
  const out: Source[] = [];
  for (const [path, data] of Object.entries(files)) {
    const base = path.split("/").pop() ?? "";
    if (path.endsWith("/") || path.includes("__MACOSX") || base.startsWith(".") || !base.toLowerCase().endsWith(".txt")) continue;
    out.push({ name: base, text: strFromU8(data) });
  }
  return out;
}

export function guessTitle(name: string): string {
  const base = name.replace(/^.*[\\/]/, "").replace(/\.zip$/i, "").replace(/-scripts.*$/, "").replace(/_/g, " ").trim();
  return base || "Untitled show";
}
