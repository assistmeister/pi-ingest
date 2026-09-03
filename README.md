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
/ingest [--force] [--no-new-session] [--summarize] [--max-depth N] [--max-files N] [--include-hidden] [path]
```

| Flag | Effect |
|---|---|
| `path` | Directory to scan (default: session cwd) |
| `--force` | Allow home-directory / filesystem-root scans |
| `--no-new-session` | Write briefing only, don't offer a new session |
| `--summarize` | Ask the current (cheap) model for a 15-line compression of the snapshot |
| `--max-depth N` | Tree depth cap, 1–8 (default 4) |
| `--max-files N` | File cap, 50–5000 (default 500) |
| `--include-hidden` | Include dotfiles |

`.pi/ingest/briefing-<stamp>.md` (plus `latest.md`) — `.omp/ingest/` on Oh My Pi:

## Home-directory guard

Scanning `$HOME` or `/` triggers a confirmation dialog explaining the risk
(secrets, media trees, dotfiles) and suggesting a repo subdirectory. In
headless/print mode there's no dialog, so those roots are refused unless
`--force` is passed. The acknowledgement is recorded in the briefing.

## What the briefing contains

- **What it does** — README head (40 lines) + project signals
  (`package.json` name/version/scripts, `pyproject.toml`, `Cargo.toml`,
  `go.mod`, Dockerfile, CI presence)
- **Where things are** — capped tree + likely entry points + file mix
- **Working state** — git branch, `status --short`, last 5 commits

## Costs

| Step | Tokens |
|---|---|
| Tree walk + manifest peeks | 0 (local fs) |
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
