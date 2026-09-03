import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/ingest";

describe("parseArgs", () => {
  test("defaults", () => {
    const a = parseArgs("");
    expect(a.path).toBeNull();
    expect(a.goal).toBeNull();
    expect(a.force).toBe(false);
    expect(a.analyze).toBe(false);
    expect(a.maxDepth).toBe(4);
    expect(a.maxFiles).toBe(500);
  });

  test("analyse spelling is accepted", () => {
    expect(parseArgs("--analyse").analyze).toBe(true);
    expect(parseArgs("--analyze").analyze).toBe(true);
  });

  test("goal forms and path", () => {
    expect(parseArgs('--goal "Add dark mode"').goal).toBe("Add dark mode");
    expect(parseArgs("--goal=Fix-it").goal).toBe("Fix-it");
    expect(parseArgs("--max-files 50 somedir").path).toBe("somedir");
    expect(parseArgs("--force --max-depth=2").force).toBe(true);
  });
});
