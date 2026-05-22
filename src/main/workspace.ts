import {
  closeSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "fs";
import { join, resolve, sep } from "path";

/**
 * Read-only workspace file access for the Chat context-folder pane —
 * the "File Browser" line item of issue #27.
 *
 * Every entry point is path-contained to a caller-supplied `root` (the
 * conversation's context folder): `..` traversal, absolute-path
 * injection, and symlink escapes are all rejected before any directory
 * is listed or any file is read. The renderer never passes raw paths to
 * `fs` — it passes a (root, relativePath) pair and these functions are
 * the only place that joins them.
 */

export const WORKSPACE_PATH_ERROR = "Path escapes the workspace root.";

/** Default cap for text-file previews — 1 MiB. */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

export interface DirEntry {
  name: string;
  isDir: boolean;
  /** Byte size for files; 0 for directories. */
  size: number;
}

export interface TextFileResult {
  text: string;
  /** True on-disk byte size (may exceed `text` length when truncated). */
  size: number;
  /** True when the file is larger than the read cap. */
  truncated: boolean;
}

/**
 * Resolve `relPath` beneath `root` and assert the result stays inside
 * `root`. Pure — path arithmetic only, no filesystem access — so it is
 * cheap to call and trivial to unit-test.
 *
 * Guards against two escapes:
 *  - `..` traversal — `path.resolve` normalises it, then the prefix
 *    check rejects anything that climbed out.
 *  - absolute `relPath` — `path.resolve` lets a later absolute segment
 *    discard `root` entirely; the same prefix check catches that.
 *
 * The `sep` in the prefix check is load-bearing: it stops a sibling
 * directory that merely shares a name prefix (`<root>` vs `<root>-evil`)
 * from passing as "contained".
 *
 * Returns the resolved absolute path; throws `WORKSPACE_PATH_ERROR` on escape.
 */
export function resolveWithinRoot(root: string, relPath: string): string {
  const absRoot = resolve(root);
  const target = resolve(absRoot, relPath);
  if (target !== absRoot && !target.startsWith(absRoot + sep)) {
    throw new Error(WORKSPACE_PATH_ERROR);
  }
  return target;
}

/**
 * Second containment layer: resolve symlinks with `realpath` and re-check
 * that the *real* target is still inside the *real* root. Catches a
 * symlink planted inside the root that points elsewhere — which the
 * pure lexical check in `resolveWithinRoot` cannot see.
 *
 * Runs `resolveWithinRoot` first, so `..` traversal is rejected before
 * any filesystem call is made.
 */
function realContainedTarget(root: string, relPath: string): string {
  const target = resolveWithinRoot(root, relPath);
  const realRoot = realpathSync(resolve(root));
  const realTarget = realpathSync(target);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw new Error(WORKSPACE_PATH_ERROR);
  }
  return realTarget;
}

/**
 * List the immediate children of `dirPath` (relative to `root`).
 * Directories sort first, then names alphabetically. An unreadable
 * child (permissions, broken symlink) is skipped rather than aborting
 * the whole listing.
 */
export function listDir(root: string, dirPath: string): DirEntry[] {
  const dir = realContainedTarget(root, dirPath);
  const entries: DirEntry[] = [];
  for (const name of readdirSync(dir)) {
    try {
      const st = statSync(join(dir, name));
      entries.push({
        name,
        isDir: st.isDirectory(),
        size: st.isDirectory() ? 0 : st.size,
      });
    } catch {
      // Unreadable child — skip it rather than failing the listing.
    }
  }
  entries.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
  );
  return entries;
}

/**
 * Read a text file (relative to `root`), capped at `maxBytes`. Only the
 * capped prefix is read off disk, so previewing a huge file never
 * inflates memory. `truncated` is true when the file exceeds the cap.
 */
export function readTextFile(
  root: string,
  filePath: string,
  maxBytes: number = MAX_TEXT_FILE_BYTES,
): TextFileResult {
  const file = realContainedTarget(root, filePath);
  const st = statSync(file);
  if (st.isDirectory()) {
    throw new Error("Cannot read a directory as a text file.");
  }
  const cap = Math.min(st.size, Math.max(0, maxBytes));
  const buf = Buffer.alloc(cap);
  if (cap > 0) {
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, cap, 0);
    } finally {
      closeSync(fd);
    }
  }
  return {
    text: buf.toString("utf-8"),
    size: st.size,
    truncated: st.size > cap,
  };
}
