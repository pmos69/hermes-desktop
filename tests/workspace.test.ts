import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  listDir,
  MAX_TEXT_FILE_BYTES,
  readTextFile,
  resolveWithinRoot,
  WORKSPACE_PATH_ERROR,
} from "../src/main/workspace";

describe("resolveWithinRoot — pure path containment", () => {
  const root = process.platform === "win32" ? "C:\\ws\\root" : "/ws/root";

  it("resolves paths that stay inside the root", () => {
    expect(resolveWithinRoot(root, "")).toBe(resolveWithinRoot(root, "."));
    expect(resolveWithinRoot(root, "file.txt")).toBe(join(root, "file.txt"));
    expect(resolveWithinRoot(root, "a/b/c.txt")).toBe(join(root, "a/b/c.txt"));
    // A `..` that normalises back inside the root is allowed.
    expect(resolveWithinRoot(root, "a/../b.txt")).toBe(join(root, "b.txt"));
  });

  it("rejects ../ traversal out of the root", () => {
    expect(() => resolveWithinRoot(root, "..")).toThrow(WORKSPACE_PATH_ERROR);
    expect(() => resolveWithinRoot(root, "../secrets")).toThrow(
      WORKSPACE_PATH_ERROR,
    );
    expect(() => resolveWithinRoot(root, "a/../../secrets")).toThrow(
      WORKSPACE_PATH_ERROR,
    );
  });

  it("rejects a sibling directory that shares a name prefix", () => {
    // <root> vs <root>-evil — the separator guard must catch this.
    expect(() => resolveWithinRoot(root, "../root-evil/x")).toThrow(
      WORKSPACE_PATH_ERROR,
    );
  });

  it("rejects absolute-path injection", () => {
    const abs =
      process.platform === "win32" ? "C:\\Windows\\System32" : "/etc/passwd";
    expect(() => resolveWithinRoot(root, abs)).toThrow(WORKSPACE_PATH_ERROR);
  });
});

describe("listDir / readTextFile — filesystem access", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hermes-ws-"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "note.md"), "# hello\n");
    writeFileSync(join(root, "readme.txt"), "top-level file");
    writeFileSync(join(root, "a.txt"), "a");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists immediate children — directories first, then alphabetical", () => {
    const entries = listDir(root, "");
    expect(entries.map((e) => e.name)).toEqual(["docs", "a.txt", "readme.txt"]);
    expect(entries[0]).toMatchObject({ name: "docs", isDir: true, size: 0 });
    const readme = entries.find((e) => e.name === "readme.txt")!;
    expect(readme.isDir).toBe(false);
    expect(readme.size).toBe("top-level file".length);
  });

  it("lists a nested subdirectory", () => {
    expect(listDir(root, "docs").map((e) => e.name)).toEqual(["note.md"]);
  });

  it("reads a text file with size + truncated metadata", () => {
    const res = readTextFile(root, "docs/note.md");
    expect(res.text).toBe("# hello\n");
    expect(res.size).toBe(8);
    expect(res.truncated).toBe(false);
  });

  it("caps oversized files and reports truncated", () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(5000));
    const res = readTextFile(root, "big.txt", 1000);
    expect(res.text.length).toBe(1000);
    expect(res.size).toBe(5000);
    expect(res.truncated).toBe(true);
  });

  it("exposes a 1 MiB default text cap", () => {
    expect(MAX_TEXT_FILE_BYTES).toBe(1024 * 1024);
  });

  it("rejects ../ traversal in listDir and readTextFile", () => {
    expect(() => listDir(root, "../")).toThrow(WORKSPACE_PATH_ERROR);
    expect(() => readTextFile(root, "../../etc/hosts")).toThrow(
      WORKSPACE_PATH_ERROR,
    );
  });

  it("refuses to read a directory as a text file", () => {
    expect(() => readTextFile(root, "docs")).toThrow();
  });

  it("rejects a symlink inside the root that escapes it", () => {
    const outside = mkdtempSync(join(tmpdir(), "hermes-outside-"));
    writeFileSync(join(outside, "secret.txt"), "SECRET");
    let symlinkCreated = true;
    try {
      symlinkSync(outside, join(root, "escape"), "dir");
    } catch {
      // Windows without Developer Mode / admin can't create symlinks —
      // skip the assertion there; the pure + traversal tests still cover
      // the primary containment path.
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      expect(() => listDir(root, "escape")).toThrow(WORKSPACE_PATH_ERROR);
      expect(() => readTextFile(root, "escape/secret.txt")).toThrow(
        WORKSPACE_PATH_ERROR,
      );
    }
    rmSync(outside, { recursive: true, force: true });
  });
});
