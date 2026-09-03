// pi-ingest extension entry. Targets upstream Pi (@mariozechner/pi-coding-agent);
// loads on Oh My Pi too via its legacy-specifier compat rewrite. Only the
// shared API subset is used: registerCommand/registerTool, ui.confirm/notify/
// setStatus, newSession({ setup }), TypeBox tool schemas.
//
// Workflow (manual cheap-model flow):
//   1. User switches to a cheap model: /model (pick) or pi --model <pattern>
//   2. User runs: /ingest [--force] [--no-new-session] [--max-files N] [path]
//   3. Extension scans deterministically (zero completion tokens), writes a
//      planner-ready briefing under <root>/.pi/ingest/ (.omp on Oh My Pi),
//      and offers to open a fresh session with the briefing pre-injected.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
  ANALYST_HEADER,
  appendAnalystNotes,
  isBriefingPath,
  isDangerousRoot,
  isHomeDir,
  renderBriefing,
  scanWorkspace,
} from "./scanner";

interface IngestArgs {
  path: string | null;
  goal: string | null;
  force: boolean;
  noNewSession: boolean;
  analyze: boolean;
  summarize: boolean;
  maxDepth: number;
  maxFiles: number;
  includeHidden: boolean;
}

function parseArgs(raw: string): IngestArgs {
  const out: IngestArgs = {
    path: null,
    goal: null,
    force: false,
    noNewSession: false,
    analyze: false,
    summarize: false,
    maxDepth: 4,
    maxFiles: 500,
    includeHidden: false,
  };
  const tokens = raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].replace(/^["']|["']$/g, "");
    if (t === "--force" || t === "-f") out.force = true;
    else if (t === "--no-new-session") out.noNewSession = true;
    else if (t === "--summarize") out.summarize = true;
    else if (t === "--analyze") out.analyze = true;
    else if (t === "--goal" && i + 1 < tokens.length) out.goal = tokens[++i].replace(/^["']|["']$/g, "");
    else if (t.startsWith("--goal=")) out.goal = t.slice("--goal=".length).replace(/^["']|["']$/g, "");
    else if (t === "--max-depth" && i + 1 < tokens.length) out.maxDepth = Math.max(1, Math.min(8, Number(tokens[++i]) || 4));
    else if (t === "--max-files" && i + 1 < tokens.length) out.maxFiles = Math.max(50, Math.min(5000, Number(tokens[++i]) || 500));
    else if (t.startsWith("--max-depth=")) out.maxDepth = Math.max(1, Math.min(8, Number(t.split("=")[1]) || 4));
    else if (t.startsWith("--max-files=")) out.maxFiles = Math.max(50, Math.min(5000, Number(t.split("=")[1]) || 500));
    else if (t.startsWith("--")) {
      // Unknown flag: ignore (forward-compatible).
    } else if (out.path === null) {
      out.path = t;
    }
  }
  return out;
}

function briefingStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export default function piIngest(pi: ExtensionAPI) {
  // Briefing dir follows the host: upstream Pi uses `.pi`, Oh My Pi `.omp`.
  // `zod` only exists on the OMP ExtensionAPI, so its presence identifies OMP.
  const stateDir = "zod" in (pi as unknown as Record<string, unknown>) ? ".omp" : ".pi";
  pi.registerCommand("ingest", {
    description:
      "Cheap context ingestion: scan workspace, write planner-ready briefing, offer a fresh session. Run under a cheap model first.",
    handler: async (args, ctx) => {
      const a = parseArgs(args ?? "");
      const root = resolve(ctx.cwd, a.path ?? ".");

      if (!existsSync(root)) {
        ctx.ui.notify(`pi-ingest: path does not exist: ${root}`, "error");
        return;
      }

      // Home-directory guard: warn loudly, require explicit consent.
      const dangerous = isDangerousRoot(root);
      const home = isHomeDir(root);
      if (dangerous && !a.force) {
        if (!ctx.hasUI) {
          // No TUI/turn here: notify is silent headless, so report on stderr
          // (safe: no live TUI to corrupt when hasUI is false).
          const text = `pi-ingest: refusing to scan ${root} without --force (home/root guard, no UI to confirm).`;
          ctx.ui.notify(text, "error");
          console.error(text);
          return;
        }
        const ok = await ctx.ui.confirm(
          "Scan a very broad directory?",
          home
            ? `You are about to ingest your HOME directory (${root}). This can sweep up secrets, huge media trees, and dotfiles. Prefer a repo subdirectory. Continue anyway?`
            : `You are about to ingest filesystem root (${root}). This is almost never what you want. Continue anyway?`,
        );
        if (!ok) {
          ctx.ui.notify("pi-ingest: scan cancelled.", "info");
          return;
        }
      }

      ctx.ui.setStatus("pi-ingest", "scanning workspace…");
      let snapshot;
      try {
        snapshot = scanWorkspace({
          root,
          maxDepth: a.maxDepth,
          maxFiles: a.maxFiles,
          includeHidden: a.includeHidden,
        });
      } finally {
        ctx.ui.setStatus("pi-ingest", undefined);
      }

      const briefing = renderBriefing(snapshot, dangerous);
      const dir = join(root, stateDir, "ingest");
      mkdirSync(dir, { recursive: true });
      const stamp = briefingStamp();
      const file = join(dir, `briefing-${stamp}.md`);
      writeFileSync(file, briefing, "utf8");
      writeFileSync(join(dir, "latest.md"), briefing, "utf8");

      const model = ctx.model ? `${ctx.model}` : "current model";
      ctx.ui.notify(
        `pi-ingest: briefing written (${snapshot.fileCount} files, ${snapshot.dirCount} dirs` +
          `${snapshot.truncated ? ", truncated" : ""}) → ${file}`,
        "info",
      );

      // Model-driven passes below work in two ways: interactively the prompt
      // is sent as a message (turn starts automatically); headless (`-p`) the
      // command consumes the turn, so the same prompt is also dropped to a
      // file for a follow-up invocation.
      const dropPrompt = (name: string, prompt: string): string => {
        const p = join(dir, `${name}-${stamp}.md`);
        writeFileSync(p, prompt, "utf8");
        return p;
      };
      const announcePrompt = (p: string): void => {
        if (ctx.hasUI) ctx.ui.notify(`pi-ingest: model prompt saved → ${p}`, "info");
        else console.error(`pi-ingest: model prompt saved → ${p}`);
      };

      if (a.summarize) {
        // Hand the deterministic snapshot to the current (cheap, user-selected)
        // model for a one-turn compression pass.
        const prompt =
          `Compress the workspace snapshot below into a 15-line executive summary ` +
          `(purpose, stack, entry points, gotchas). Snapshot:\n\n${briefing.slice(0, 12000)}`;
        announcePrompt(dropPrompt("summary-prompt", prompt));
        pi.sendUserMessage(prompt);
        return;
      }
      // Analyst pass: the current (cheap, user-selected) model triages the
      // deterministic snapshot — reads the highest-value files, judges what
      // matters vs noise, and persists notes via append_analyst_notes.
      // The snapshot stays untouched as the coverage guarantee. After the
      // turn finishes, the planner offer below picks up the annotated file.
      let handoffText = briefing.slice(0, 15000);
      let notesPresent = false;
      if (a.analyze) {
        const prompt =
          `You are triaging this workspace for a planner model that must NOT re-walk the tree. ` +
          `Briefing file: ${file}\n\n` +
          `1. Read the briefing file.\n` +
          `2. Read at most 12 files you judge most load-bearing (entry points, core abstractions, docs that explain why — skip tests, generated code, vendored deps).\n` +
          `3. Decide what is valuable vs noise: ranked must-reads, key abstractions in one line each, gotchas, and what the planner can safely ignore.\n` +
          `4. Persist exactly once via append_analyst_notes({ briefing: ${JSON.stringify(file)}, notes: "<markdown>" }). ` +
          `Do not edit anything else.\n\n` +
          `Snapshot (same content as the briefing file):\n\n${briefing.slice(0, 12000)}`;
        announcePrompt(dropPrompt("analyst-prompt", prompt));
        pi.sendUserMessage(prompt);
        try {
          await ctx.waitForIdle();
        } catch {
          return; // aborted by user mid-triage
        }
        try {
          const fromDisk = readFileSync(file, "utf8");
          if (fromDisk.includes(ANALYST_HEADER)) {
            notesPresent = true;
            handoffText = fromDisk.slice(0, 15000);
          }
        } catch {
          // briefing unreadable: fall through with the snapshot
        }
      }

      if (a.noNewSession || !ctx.hasUI) {
        // A headless run has no UI session to switch: report the artifact.
        if (!ctx.hasUI) {
          console.error(
            `pi-ingest: briefing ready → ${file}${notesPresent ? " (analyst notes appended)" : ""}`,
          );
        }
        return;
      }

      // Offer the planner handoff: fresh session with the briefing injected.
      const open = await ctx.ui.confirm(
        notesPresent ? "Briefing complete" : "Briefing ready",
        notesPresent
          ? `Analyst notes appended to ${file}. Open a fresh session with it pre-loaded for your planner model?`
          : `Briefing saved to ${file} (scanned under ${model}). Open a fresh session with it pre-loaded for your planner model?`,
      );
      if (!open) return;

      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        setup: async (sm) => {
          sm.appendMessage({
            role: "user",
            timestamp: Date.now(),
            content: [
              {
                type: "text",
                text:
                  `Workspace briefing for the planner (produced cheaply by pi-ingest — do NOT re-walk the tree; read files only as needed):\n\n${handoffText}\n\n` +
                  (a.goal
                    ? `My goal is: ${a.goal}. Propose a plan first, then wait for approval before implementing.`
                    : `My goal is: <describe your goal here>. Propose a plan first.`),
              },
            ],
          });
        },
      });
    },
  });

  pi.registerTool({
    name: "ingest_workspace",
    label: "Ingest Workspace",
    description:
      "Deterministically scan a workspace directory (git-aware, capped) and return a planner-ready briefing. Prefer this over re-walking the tree with reads. Refuses home/root without force=true.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to scan, relative to cwd. Defaults to cwd." })),
      maxDepth: Type.Optional(Type.Number({ description: "Tree depth cap 1-8 (default 4)." })),
      maxFiles: Type.Optional(Type.Number({ description: "File cap 50-5000 (default 500)." })),
      includeHidden: Type.Optional(Type.Boolean({ description: "Include dotfiles (default false)." })),
      force: Type.Optional(Type.Boolean({ description: "Allow home-directory or filesystem-root scans." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = resolve(ctx.cwd, params.path ?? ".");
      if (isDangerousRoot(root) && !params.force) {
        return {
          content: [
            {
              type: "text",
              text: `Refused: ${root} is a home-directory or filesystem-root scan. Re-run with force=true or pick a repo subdirectory.`,
            },
          ],
          details: { root, refused: true },
        };
      }
      const snapshot = scanWorkspace({
        root,
        maxDepth: Math.max(1, Math.min(8, params.maxDepth ?? 4)),
        maxFiles: Math.max(50, Math.min(5000, params.maxFiles ?? 500)),
        includeHidden: params.includeHidden ?? false,
      });
      const briefing = renderBriefing(snapshot, isDangerousRoot(root));
      return {
        content: [{ type: "text", text: briefing.slice(0, 15000) }],
        details: {
          root: snapshot.root,
          fileCount: snapshot.fileCount,
          dirCount: snapshot.dirCount,
          truncated: snapshot.truncated,
        },
      };
    },
  });
  pi.registerTool({
    name: "append_analyst_notes",
    label: "Append Analyst Notes",
    description:
      "Append a timestamped 'Analyst notes' section to a pi-ingest briefing file. " +
      "Use after triaging a workspace: ranked must-reads, key abstractions, gotchas, safe-to-ignore. " +
      "Only briefing files (…/ingest/briefing-*.md, latest.md) are accepted; everything else is refused.",
    parameters: Type.Object({
      briefing: Type.String({ description: "Absolute path to the briefing file from /ingest." }),
      notes: Type.String({ description: "Markdown analyst notes to append." }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!isBriefingPath(params.briefing)) {
        return {
          content: [{ type: "text", text: `Refused: not a pi-ingest briefing file: ${params.briefing}` }],
          details: { briefing: params.briefing, refused: true },
        };
      }
      let existing: string;
      try {
        existing = readFileSync(params.briefing, "utf8");
      } catch {
        return {
          content: [{ type: "text", text: `Failed to read briefing file: ${params.briefing}` }],
          details: { briefing: params.briefing, refused: true },
        };
      }
      const stamp = briefingStamp();
      const updated = appendAnalystNotes(existing, params.notes, stamp);
      writeFileSync(params.briefing, updated, "utf8");
      // Keep latest.md in sync when a stamped briefing gains notes.
      if (basename(params.briefing).startsWith("briefing-")) {
        writeFileSync(join(dirname(params.briefing), "latest.md"), updated, "utf8");
      }
      return {
        content: [{ type: "text", text: `Analyst notes appended to ${params.briefing}` }],
        details: { briefing: params.briefing, stamp },
      };
    },
  });
}
