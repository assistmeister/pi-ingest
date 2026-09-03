// Deterministic workspace scanner for pi-ingest.
// Zero dependencies, sync fs, capped output. Runs without any LLM call so the
// expensive planner model never pays for the tree walk.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

export interface ScanOptions {
  root: string;
  maxDepth?: number;
  maxFiles?: number;
  maxDirs?: number;
  /** Max bytes peeked from any single text file (README/manifests). */
  peekBytes?: number;
  includeHidden?: boolean;
}

export interface GitState {
  branch: string | null;
  statusShort: string | null; // `git status --short`, truncated
  logShort: string | null; // last 5 oneline
}

export interface ManifestHit {
  file: string; // repo-relative
  kind:
    | "node"
    | "python"
    | "rust"
    | "go"
    | "docker"
    | "make"
    | "ci"
    | "readme"
    | "other";
  summary: string; // one-to-few lines, already truncated
}

export interface WorkspaceSnapshot {
  root: string;
  tree: string;
  truncated: boolean;
  truncateReasons: string[];
  fileCount: number;
  dirCount: number;
  extCounts: Array<[string, number]>;
  manifests: ManifestHit[];
  readmeHead: string | null;
  readmePath: string | null;
  entryPoints: string[];
  git: GitState;
  bytesPeeked: number;
}

export type RunFn = (cmd: string, args: string[], cwd: string) => string | null;

/** Directories never descended into (before .gitignore). */
const ALWAYS_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "coverage",
  ".nyc_output",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  "vendor",
  "Pods",
  ".gradle",
  ".idea",
  ".vscode",
  ".cache",
]);

const ALWAYS_SKIP_FILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

const MANIFEST_FILES: Record<string, ManifestHit["kind"]> = {
  "package.json": "node",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  "setup.py": "python",
  "setup.cfg": "python",
  "Cargo.toml": "rust",
  "go.mod": "go",
  Dockerfile: "docker",
  "docker-compose.yml": "docker",
  "docker-compose.yaml": "docker",
  Makefile: "make",
};

const README_NAMES = ["README.md", "README.MD", "README.txt", "README", "readme.md"];

const ENTRY_CANDIDATES = [
  "src/index.ts",
  "src/index.js",
  "src/main.ts",
  "src/main.js",
  "src/main.py",
  "src/app.py",
  "src/lib.rs",
  "src/main.rs",
  "main.py",
  "app.py",
  "main.go",
  "cmd/main.go",
  "index.ts",
  "index.js",
  "main.ts",
];

/** True when `p` resolves to the user's home directory itself. */
export function isHomeDir(p: string): boolean {
  return resolve(p) === resolve(homedir());
}

/** Roots we refuse to scan without explicit --force (data-loss / noise risk). */
export function isDangerousRoot(p: string): boolean {
  const r = resolve(p);
  return r === "/" || r === resolve(homedir());
}

export function defaultRun(cmd: string, args: string[], cwd: string): string | null {
  try {
    // Bun.spawnSync is available in the extension runtime; fall back to
    // node:child_process when running under plain node (tests).
    const B = (globalThis as unknown as { Bun?: unknown }).Bun as
      | {
          spawnSync: (
            c: string[],
            o: { cwd: string; stdout: "pipe"; stderr: "pipe" },
          ) => { exitCode: number; stdout: unknown };
        }
      | undefined;
    if (B) {
      const out = B.spawnSync([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      if (out.exitCode !== 0) return null;
      return String(out.stdout).trim() || null;
    }
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const out = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 5000 });
    if (out.status !== 0) return null;
    const s = (out.stdout ?? "").trim();
    return s || null;
  } catch {
    return null;
  }
}

interface IgnoreRule {
  dirOnly: boolean;
  pattern: string; // basename glob, no slashes (nested rules simplified to basename)
  raw: string;
}

function parseGitignore(root: string): IgnoreRule[] {
  const f = join(root, ".gitignore");
  if (!existsSync(f)) return [];
  let text: string;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("!")) continue; // skip comments/negations
    const dirOnly = t.endsWith("/");
    const noSlash = t.replace(/\/+$/, "");
    const base = noSlash.includes("/") ? basename(noSlash) : noSlash;
    if (base) rules.push({ dirOnly, pattern: base, raw: t });
  }
  return rules;
}

/** Minimal `*`/`?` glob against a basename. */
function globMatch(pattern: string, name: string): boolean {
  let px = 0;
  let nx = 0;
  let star = -1;
  let mark = 0;
  while (nx < name.length) {
    if (px < pattern.length && (pattern[px] === "?" || pattern[px] === name[nx])) {
      px++;
      nx++;
    } else if (px < pattern.length && pattern[px] === "*") {
      star = px++;
      mark = nx;
    } else if (star !== -1) {
      px = star + 1;
      nx = ++mark;
    } else {
      return false;
    }
  }
  while (px < pattern.length && pattern[px] === "*") px++;
  return px === pattern.length;
}

function ignoredBy(name: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (globMatch(r.pattern, name)) return true;
  }
  return false;
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function safeStat(p: string): { isDir: boolean; isFile: boolean; size: number } | null {
  try {
    const s = statSync(p, { throwIfNoEntry: false });
    if (!s) return null;
    return { isDir: s.isDirectory(), isFile: s.isFile(), size: s.size };
  } catch {
    return null;
  }
}

function peekText(abs: string, maxBytes: number): { text: string; bytes: number } {
  try {
    const buf = readFileSync(abs);
    const slice = buf.subarray(0, maxBytes);
    // Strip non-printable noise: if >10% NUL bytes, treat as binary.
    let nuls = 0;
    for (let i = 0; i < slice.length; i++) if (slice[i] === 0) nuls++;
    if (slice.length > 0 && nuls / slice.length > 0.1) return { text: "", bytes: 0 };
    return { text: slice.toString("utf8"), bytes: slice.length };
  } catch {
    return { text: "", bytes: 0 };
  }
}

function firstLines(text: string, n: number): string {
  return text.split("\n").slice(0, n).join("\n").trimEnd();
}

function summarizeManifest(rel: string, kind: ManifestHit["kind"], text: string): string {
  if (kind === "node") {
    try {
      const j = JSON.parse(text) as {
        name?: string;
        version?: string;
        description?: string;
        scripts?: Record<string, string>;
      };
      const scripts = j.scripts ? Object.keys(j.scripts).slice(0, 12).join(", ") : "—";
      const desc = j.description ? ` — ${j.description.slice(0, 120)}` : "";
      return `${j.name ?? "?"}@${j.version ?? "?"}${desc} | scripts: ${scripts}`;
    } catch {
      return firstLines(text, 5);
    }
  }
  if (kind === "python" && rel.endsWith(".toml")) {
    const m =
      text.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ??
      text.match(/^name\s*=\s*(.+)$/m)?.[1]?.trim() ??
      "?";
    return `project: ${m} (${rel})`;
  }
  if (kind === "rust") {
    const name = text.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? "?";
    const ver = text.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "?";
    return `${name}@${ver}`;
  }
  if (kind === "go") {
    const mod = text.match(/^module\s+(\S+)/m)?.[1] ?? "?";
    return `module ${mod}`;
  }
  return firstLines(text, 5);
}

export function scanWorkspace(o: ScanOptions, run: RunFn = defaultRun): WorkspaceSnapshot {
  const root = resolve(o.root);
  const maxDepth = o.maxDepth ?? 4;
  const maxFiles = o.maxFiles ?? 500;
  const maxDirs = o.maxDirs ?? 300;
  const peekBytes = o.peekBytes ?? 8000;
  const includeHidden = o.includeHidden ?? false;

  const rules = parseGitignore(root);
  const truncateReasons: string[] = [];
  const treeLines: string[] = [basename(root) + "/"];
  const extCounts = new Map<string, number>();
  const manifests: ManifestHit[] = [];
  const entryPoints: string[] = [];
  let fileCount = 0;
  let dirCount = 0;
  let bytesPeeked = 0;
  let truncated = false;

  const relOf = (abs: string) => relative(root, abs) || ".";

  // Breadth-first walk so depth caps degrade gracefully (top levels complete).
  const queue: Array<{ abs: string; depth: number; prefix: string }> = [{ abs: root, depth: 0, prefix: "" }];
  const seenManifest = new Set<string>();

  const considerFile = (abs: string, name: string) => {
    fileCount++;
    const ext = extname(name).toLowerCase() || "(no-ext)";
    extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    const rel = relOf(abs);
    if (ALWAYS_SKIP_FILES.has(name)) return;
    if (MANIFEST_FILES[name]) {
      const kind = MANIFEST_FILES[name];
      if (!seenManifest.has(rel)) {
        seenManifest.add(rel);
        const { text, bytes } = peekText(abs, peekBytes);
        bytesPeeked += bytes;
        if (text) manifests.push({ file: rel, kind, summary: summarizeManifest(rel, kind, text).slice(0, 300) });
      }
    } else if (name === ".github" || name.endsWith(".yml") || name.endsWith(".yaml")) {
      // CI hints collected cheaply below via tree; skip content.
    }
    if (ENTRY_CANDIDATES.includes(rel)) entryPoints.push(rel);
  };

  while (queue.length > 0) {
    const { abs, depth, prefix } = queue.shift()!;
    if (depth > maxDepth) {
      truncated = true;
      truncateReasons.push(`depth cap (${maxDepth}) at ${relOf(abs)}`);
      continue;
    }
    const entries = safeReadDir(abs);
    const visible = entries.filter((n) => {
      if (!includeHidden && n.startsWith(".") && abs === root) {
        // Keep root dotfiles that carry signal; skip the rest at top level.
        return [".gitignore", ".env.example", ".nvmrc", ".python-version"].includes(n);
      }
      if (!includeHidden && n.startsWith(".")) return false;
      return true;
    });

    for (const name of visible) {
      const child = join(abs, name);
      const st = safeStat(child);
      if (!st) continue;
      const rel = relOf(child);
      if (st.isDir) {
        if (ALWAYS_SKIP_DIRS.has(name) || ignoredBy(name, true, rules)) continue;
        if (dirCount >= maxDirs) {
          truncated = true;
          continue;
        }
        dirCount++;
        treeLines.push(`${prefix}├── ${name}/`);
        queue.push({ abs: child, depth: depth + 1, prefix: prefix + "│   " });
      } else if (st.isFile) {
        if (ignoredBy(name, false, rules) || ALWAYS_SKIP_FILES.has(name)) continue;
        if (fileCount >= maxFiles) {
          truncated = true;
          continue;
        }
        considerFile(child, name);
        treeLines.push(`${prefix}├── ${name}`);
      }
      if (treeLines.length > maxFiles + maxDirs + 4) {
        truncated = true;
        break;
      }
    }
    if (truncated) {
      treeLines.push(`${prefix}└── … (truncated: caps maxFiles=${maxFiles} maxDirs=${maxDirs} maxDepth=${maxDepth})`);
      if (!truncateReasons.includes("file/dir caps reached")) truncateReasons.push("file/dir caps reached");
      break;
    }
  }

  // README head: cheapest "what does this do" signal.
  let readmeHead: string | null = null;
  let readmePath: string | null = null;
  for (const n of README_NAMES) {
    const abs = join(root, n);
    if (existsSync(abs)) {
      const { text, bytes } = peekText(abs, peekBytes);
      bytesPeeked += bytes;
      readmePath = n;
      readmeHead = text ? firstLines(text, 40) : null;
      break;
    }
  }

  // CI presence hint.
  const ciDirs = [".github/workflows", ".gitlab-ci.yml", ".circleci", "azure-pipelines.yml"];
  for (const c of ciDirs) {
    if (existsSync(join(root, c))) {
      manifests.push({ file: c, kind: "ci", summary: "present" });
      break;
    }
  }

  const extSorted = [...extCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  // Git state, best-effort (never throws).
  const git: GitState = { branch: null, statusShort: null, logShort: null };
  if (existsSync(join(root, ".git"))) {
    git.branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root)?.slice(0, 80) ?? null;
    const status = run("git", ["status", "--short"], root);
    git.statusShort = status ? firstLines(status, 20) : "(clean)";
    git.logShort = run("git", ["log", "--oneline", "-5"], root);
  }

  return {
    root,
    tree: treeLines.join("\n"),
    truncated,
    truncateReasons,
    fileCount,
    dirCount,
    extCounts: extSorted,
    manifests,
    readmeHead,
    readmePath,
    entryPoints,
    git,
    bytesPeeked,
  };
}
export function renderBriefing(s: WorkspaceSnapshot, homeWarned: boolean): string {
  const date = new Date().toISOString();
  const lines: string[] = [];
  lines.push(`# Workspace briefing — ${basename(s.root)}`);
  lines.push(``);
  lines.push(`- Root: \`${s.root}\``);
  lines.push(`- Scanned: ${date}`);
  lines.push(
    `- Files: ${s.fileCount} (shown, caps may truncate) · dirs: ${s.dirCount} · peeked bytes: ${s.bytesPeeked}`,
  );
  lines.push(
    `- Git: ${s.git.branch ? `branch \`${s.git.branch}\`` : "not a git repo / unknown"}`,
  );
  if (s.truncated) lines.push(`- ⚠️ Truncated: ${s.truncateReasons.join("; ") || "caps reached"}`);
  if (homeWarned) lines.push(`- ⚠️ Home-directory scan acknowledged by user`);
  lines.push(``);
  lines.push(`> Produced by pi-ingest under a cheap model. Hand this file to your planner model`);
  lines.push(`> (e.g. switch model, then paste or \`@briefing-file\`) instead of re-walking the tree.`);
  lines.push(``);
  lines.push(`## What it does`);
  lines.push(``);
  if (s.readmeHead) {
    lines.push(`From \`${s.readmePath}\` (first 40 lines):`);
    lines.push(``);
    lines.push("```");
    lines.push(s.readmeHead.slice(0, 3000).replaceAll("```", "~~~"));
  } else {
    lines.push(`No README found at root.`);
  }
  if (s.manifests.length > 0) {
    lines.push(``);
    lines.push(`Project signals:`);
    lines.push(``);
    for (const m of s.manifests) lines.push(`- \`${m.file}\` (${m.kind}): ${m.summary}`);
  }
  lines.push(``);
  lines.push(`## Where things are`);
  lines.push(``);
  lines.push("```");
  lines.push(s.tree.slice(0, 12000));
  lines.push("```");
  lines.push(``);
  if (s.entryPoints.length > 0) {
    lines.push(`Likely entry points: ${s.entryPoints.map((e) => `\`${e}\``).join(", ")}`);
    lines.push(``);
  }
  if (s.extCounts.length > 0) {
    lines.push(`File mix: ${s.extCounts.map(([e, n]) => `${e}×${n}`).join(", ")}`);
    lines.push(``);
  }
  if (s.git.statusShort) {
    lines.push(`## Working state`);
    lines.push(``);
    lines.push("```");
    lines.push(`status:\n${s.git.statusShort.slice(0, 1500)}`);
    if (s.git.logShort) lines.push(`\nlog:\n${s.git.logShort.slice(0, 1000)}`);
    lines.push("```");
    lines.push(``);
  }
  lines.push(`## Suggested next step for the planner`);
  lines.push(``);
  lines.push(
    `Ask the planner a scoped question and point it at this briefing first, e.g.`,
  );
  lines.push(`"Using the workspace briefing above, propose a plan for <goal>. Read files only as needed."`);
  lines.push(``);
  return lines.join("\n");
}
