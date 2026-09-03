import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isDangerousRoot,
  isHomeDir,
  renderBriefing,
  scanWorkspace,
} from "../src/scanner";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-ingest-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0", scripts: { dev: "x", build: "y" } }),
  );
  writeFileSync(join(root, "README.md"), "# Demo\n\nDoes things.\n");
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = {};\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  return root;
}

describe("home guard", () => {
  test("home is dangerous, tmp fixture is not", () => {
    expect(isHomeDir(process.env.HOME!)).toBe(true);
    expect(isDangerousRoot(process.env.HOME!)).toBe(true);
    expect(isDangerousRoot("/")).toBe(true);
    expect(isDangerousRoot(fixture())).toBe(false);
  });
});

describe("scanWorkspace", () => {
  test("skips node_modules, finds manifests and entry points", () => {
    const s = scanWorkspace({ root: fixture() });
    expect(s.manifests.some((m) => m.file === "package.json")).toBe(true);
    expect(s.entryPoints).toContain("src/index.ts");
    expect(s.tree).not.toContain("node_modules");
    expect(s.readmePath).toBe("README.md");
    expect(s.fileCount).toBeGreaterThanOrEqual(3);
  });

  test("depth cap truncates instead of exploding", () => {
    let root = fixture();
    let deep = root;
    for (let i = 0; i < 10; i++) {
      deep = join(deep, `d${i}`);
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, "f.txt"), "x");
    }
    const s = scanWorkspace({ root, maxDepth: 2 });
    expect(s.truncated).toBe(true);
  });
});

describe("renderBriefing", () => {
  test("contains all planner sections", () => {
    const b = renderBriefing(scanWorkspace({ root: fixture() }), false);
    for (const h of ["# Workspace briefing", "## What it does", "## Where things are"]) {
      expect(b).toContain(h);
    }
  });
});
