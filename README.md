# pi-ingest — cheap context ingestion for oh-my-pi

One purpose: scan the current workspace **deterministically** (no LLM tokens),
write a planner-ready briefing, and open a fresh session with it pre-loaded —
so your expensive reasoning model never pays for the tree walk.

## Recommended flow (manual cheap-model handoff)

```bash
# 1. Start cheap
/model @smol

# 2. Ingest the workspace (warns on home directory, git-aware capped scan)
/ingest

# 3. A fresh session opens with the briefing injected.
#    Switch to your planner there: /model @plan
```

The scan itself costs zero completion tokens. Being on `@smol` keeps any
follow-up Q&A cheap until you hand off.

## Install

**A — user-wide (recommended):**

```bash
mkdir -p ~/.omp/agent/extensions
cp -r /path/to/pi-ingest ~/.omp/agent/extensions/pi-ingest
# restart omp
```

**B — via settings:**

```yaml
# ~/.omp/agent/config.yml
extensions:
  - /path/to/pi-ingest
```

(`package.json` declares `omp.extensions: ["./src/ingest.ts"]`, so pointing at
the directory is enough.)

**C — try once:**

```bash
omp --extension /path/to/pi-ingest
```

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

`.omp/ingest/briefing-<stamp>.md` (plus `latest.md`):
(same caps, same home guard — pass `force: true` to override).

## Home-directory guard

Scanning `$HOME` or `/` triggers a confirmation dialog explaining the risk
(secrets, media trees, dotfiles) and suggesting a repo subdirectory. In
headless/print mode there's no dialog, so those roots are refused unless
`--force` is passed. The acknowledgement is recorded in the briefing.

## What the briefing contains

`·omp/ingest/briefing-<stamp>.md` (plus `latest.md`):

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
