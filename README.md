# pi-ingest — cheap context ingestion for Pi

One purpose: scan the current workspace **deterministically** (no LLM tokens),
write a planner-ready briefing, and open a fresh session with it pre-loaded —
so your expensive reasoning model never pays for the tree walk.

## Recommended flow (manual cheap-model handoff)

```bash
# 1. Start cheap: /model, pick something small (e.g. gpt-5-mini) —
#    or launch straight into it: pi --model gpt-5-mini

# 2. Ingest the workspace (warns on home directory, git-aware capped scan)
/ingest

# 3. A fresh session opens with the briefing injected.
#    Switch to your planner there: /model
```

The scan itself costs zero completion tokens. Being on a cheap model keeps any
follow-up Q&A cheap until you hand off. (Tip: `pi --models "mini,4.6"` scopes
Ctrl+P cycling to just those fuzzy matches.)

## Requirements

- A Pi installation ([pi.dev](https://pi.dev))
- That's it — no API key needed for the scan itself (it never calls a model)

## Install

```bash
pi install git:github.com/assistmeister/pi-ingest
```

Project-local instead (`<repo>/.pi/settings.json`):

```bash
pi install -l git:github.com/assistmeister/pi-ingest
```

Or manual:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi-ingest ~/.pi/agent/extensions/pi-ingest
# restart pi
```

**Try without installing:**

```bash
pi --extension ./pi-ingest
```

(`package.json` declares both `pi.extensions` and `omp.extensions`, so every
install method picks up `./src/ingest.ts` directly — no build step.)

**Oh My Pi:** `omp --extension …`, `~/.omp/agent/extensions`, or
`<repo>/.omp/extensions`. Briefings land in `.omp/ingest/` there instead of
`.pi/ingest/`.

## Usage

```
/ingest [--force] [--no-new-session] [--summarize] [--analyze] [--goal "..."] [--max-depth N] [--max-files N] [--include-hidden] [path]
```

| Flag | Effect |
|---|---|
| `path` | Directory to scan (default: session cwd) |
| `--goal "..."` | Goal carried into the planner session (else you fill it in there) |
| `--force` | Allow home-directory / filesystem-root scans |
| `--no-new-session` | Write briefing only, don't offer a new session |
| `--summarize` | Cheap model compresses the snapshot into a 15-line summary (chat reply) |
| `--analyze` | Cheap model triages the snapshot — reads the most load-bearing files, judges value vs noise, persists `Analyst notes` into the briefing |
| `--max-depth N` | Tree depth cap, 1–8 (default 4) |
| `--max-files N` | File cap, 50–5000 (default 500) |
| `--include-hidden` | Include dotfiles |

## After the new session opens

1. It starts with the briefing (+ analyst notes, if any) and your goal
   already injected, ending in *"Propose a plan first"*.
2. Switch to the planner model (`/model`), read the plan, approve or
   redirect it.
3. Implementation happens in that session with full history — the cheap
   ingest session stays behind as a clean record.

`.pi/ingest/briefing-<stamp>.md` (plus `latest.md`) — `.omp/ingest/` on Oh My Pi.
`--summarize`/`--analyze` also drop their model prompt to a file
(`summary-prompt-<stamp>.md` / `analyst-prompt-<stamp>.md`) so headless
(`-p`) runs can feed it to a follow-up invocation — the command itself
consumes the turn there.

## Reasoning mix: deterministic base, model judgment on top

The scan is deterministic and stays the coverage guarantee — the planner can
always fall back to the full tree. `--analyze` adds a cheap-model analyst
pass on top: it reads (at most 12 files) what it judges load-bearing and
appends ranked must-reads, key abstractions, gotchas, and safe-to-ignore
notes via the least-privilege `append_analyst_notes` tool (can only touch
`…/ingest/briefing-*.md` and `latest.md`; `latest.md` mirrors new notes).
The model never edits the snapshot itself. When the triage turn finishes,
`/ingest` picks up the annotated file and offers the planner session —
which is why `--analyze` is not asked up front.

## Costs

| Step | Tokens |
|---|---|
| Tree walk + manifest peeks | 0 (local fs) |
| `--analyze` triage (cheap model) | snapshot in + ≤12 file reads + notes out — ~10–50× cheaper than the planner doing it |
| Briefing injected into new session | input tokens once |
| Planner reads | only files it actually needs |
## Limits

- `.gitignore` honoured with a small basename-glob matcher (negations `!` ignored — treated as not-ignored).
- Always skipped: `.git`, `node_modules`, `dist`, `build`, `target`, `__pycache__`, `.venv`, lockfiles, etc.
- Binary files detected by NUL-byte heuristic and skipped for peeks.
- Git info is best-effort (`git` binary, 5s timeout); absence never fails the scan.

## Host compatibility

- Primary target: upstream Pi (`@mariozechner/pi-coding-agent`, typechecked
  against 0.73.1). The entry imports that scope type-only, so nothing
  Pi-specific is bundled.
- Tool schemas use plain `typebox` (a real dependency), which both hosts
  accept. Only the API subset present in both runtimes is used
  (`newSession({ setup })`, `ui.confirm/notify/setStatus`).
- On Oh My Pi the extension loads unchanged; the briefing dir switches to
  `.omp/ingest/` (detected via OMP-only `pi.zod`). OMP users can also use
  model roles for the handoff (`/model @smol` to ingest, `/model @plan` to plan).
