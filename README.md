# Promo Finder

Reads a microdrama's timed screenplays and finds the best 20–60 second promos: clips that **open on a hook** (inside the first 3 seconds), **end on a cliffhanger** (cut before the answer) and **make sense to someone who has never seen the show**. Each promo comes with exact in/out timecodes per segment, the hook, the cliffhanger, one line on why it works, and a rank.

Built for Kuku's AI Generalist assignment (Problem 1). Next.js + TypeScript, deployed on Vercel. The input pack is confidential, so **no screenplays or outputs are in this repo**. A short synthetic sample show (`public/sample_show/`) is included for demos and tests.

## Run locally

```bash
npm install
cp .env.example .env          # put your GEMINI_API_KEY in it
npm run dev                   # http://localhost:3000
```

Command line (same pipeline, writes a folder of outputs, good for the full 50-episode run):

```bash
npm run promos -- check                                  # one uncached test call: key, model, speed, tokens
npm run promos -- run path/to/scripts.zip                # or a folder of .txt files
npm run promos -- run path/to/scripts.zip --episodes 1-4 --model gemini-3.8-flash --rpm 4
npm run promos -- run path/to/scripts.zip --baseline     # no-AI baseline, judged the same way
npm run promos -- run public/sample_show --fake          # offline stand-in model: plumbing test only
```

## How it works: who does what

| Step | Who | What |
|---|---|---|
| Parse | code | Screenplay → timed events (shots, actions, lines, sounds). Two layouts built in; an AI fallback reads unknown layouts, but code keeps a timestamp only if it literally appears in the source. |
| Show bible | AI · 1 call/show | Who's who. Speaker labels drift (one person can be "MAYA" in one episode and "THE WAITRESS" in another), so the model maps them to people. |
| Propose | AI · 1 call/episode | Picks short *moments* and 1–3 *promo drafts*, naming events **by ID only**. The model never writes a timestamp. |
| Build & check | code | Turns IDs into exact cut points: in/out snap to camera cuts and never split a line; 20–60 s; hook starts within 3 s; ends ≤ 3 s after the cliffhanger and before the event that answers it; ≤ 3 segments of ≥ 3 s, in story order. |
| Repair | AI · failures only | A draft that fails a check goes back to the model once with the exact error; the fix is re-checked by code. |
| Stitch | AI · 1 call/show | Cross-episode trailer promos from the moments (first must be a hook, last a cliffhanger); same checks. |
| Judge | AI · 1 call/promo | A *cold viewer* sees only the clip's script (no show context) and scores hook, cliffhanger and standalone 0–10, says what it understood and what confused it. |
| Rank | code | Weighted score (hook .35, cliffhanger .35, standalone .30) + a small early-episode bonus; near-duplicates removed; a "post first" five spread across hook types. |
| Review | **human** | The editor approves/rejects in the app and exports the cut list. |

All rules and weights are in `promo.config.json`.

**Why the browser runs the pipeline:** a full show is ~180 model calls (~25 min on a free tier), far past a serverless function's limit. So the page runs the steps and sends each model call through `/api/llm`, which only holds the key and forwards one call. Each call is well under Vercel's limit. Finished calls are cached in the browser, so a stopped run resumes.

**Why no database:** nothing needs to live on a server. Results download as files, editor verdicts are kept in the browser and exported as CSV, and storing Kuku's scripts in a cloud database behind a public link would break the confidentiality rule.

## Swap the model

In the app: the sidebar (provider, model, optional separate judge model). On the command line: `--preset anthropic --model <name>`, or one line in `promo.config.json`:

```json
"llm": { "preset": "gemini", "model": "gemini-3.5-flash-lite" }
```

Presets: gemini, groq, openai, anthropic, openrouter, cerebras, mistral, ollama. Any other OpenAI-compatible API (e.g. a company gateway) works via "custom" + base URL. Free tiers have low limits, so calls are throttled (`rpm`, or `--rpm` / `--concurrency` on the command line), retried on 429/5xx (each retry is printed), and cached; if the daily quota runs out, the run stops cleanly and resumes later.

A full 50-episode show is about 150–200 model calls. The default, `gemini-3.5-flash-lite`, is used because its free tier allows a few hundred requests a day; stronger models such as `gemini-3.8-flash` allow only about 20 a day free, so they are run on a few episodes for comparison. Check your limits at aistudio.google.com/rate-limit.

## Outputs (one folder or .zip per run)

| File | What |
|---|---|
| `report.html` | Readable report: post-first five, ranked table, each clip's script with hook/cliffhanger highlighted, quality stats, rejected drafts |
| `promos_ranked.csv` | One row per promo, best first |
| `cut_list.csv` | One row per segment: episode file, in/out timecodes. What an editor cuts from |
| `promos.json` | Everything (load it in the app's Review tab) |
| `run_log.json`, `calls.jsonl` | Settings (no keys), counts, every model call with tokens and latency, cost estimate |
| `llm_raw/` | Every prompt and raw model reply, unedited |

## Checking quality

* **Hard checks** on every promo (✓/✗ per check in the report); every rejected draft is listed with its reason.
* **Cold-viewer judge**: a separate call with no show context. Can a stranger follow it, and what are they left wondering?
* **Gold set**: hand-pick promos in a few episodes *before* seeing the output (`gold.csv`: `episode,start,end,note`), then `npm run promos -- eval runs/<run> --gold gold.csv` reports how many the tool found and at what rank.
* **Editor review**: approve/reject in the app → `review.csv` → `eval --review review.csv` gives precision@10.
* **Baseline and model agreement**: `npm run promos -- compare runs/A runs/B` shows how many top-10 picks two runs share (AI vs `--baseline`, or two models).

## Limits

* Text only: it judges what the script says is on screen. A look or reaction the script doesn't describe is invisible to it, and it can't check the real footage.
* The judge is a model imitating a viewer, not a viewer. Its scores rank candidates; the editor and real view-through rates decide.
* Assumes script timestamps match the final cut.

## Tests

```bash
npm test        # parser, cut rules, JSON handling, and an offline end-to-end run
```
