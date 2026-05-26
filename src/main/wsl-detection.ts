/**
 * WSL detection + sibling `~/.hermes/` discovery.
 *
 * Hermes Desktop on Windows reads its config from
 * `%LocalAppData%\hermes\`. Users who also run the `hermes` CLI inside
 * a WSL distro have a second, separate `~/.hermes/` at
 * `/home/<user>/.hermes/` on the WSL filesystem. The two are
 * independent — settings configured in one don't appear in the other.
 *
 * This module enumerates accessible WSL `~/.hermes/` directories so
 * the config-health audit can flag drift between the Windows-side
 * config and any sibling. Fail-soft throughout: any error, missing
 * tool, or unreachable distro returns an empty list — never throws.
 */

import { existsSync, readdirSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";

const IS_WINDOWS = process.platform === "win32";

/** Path to the WSL CLI on Windows. Only used as an existence check —
 *  the actual distro list comes from filesystem enumeration which
 *  doesn't require running wsl.exe (and so doesn't wake a stopped
 *  distro). */
const WSL_EXE = "C:\\Windows\\System32\\wsl.exe";

/**
 * Information about one sibling `~/.hermes/` discovered on a WSL
 * distro's filesystem. Paths are Windows UNC-style so they can be
 * passed straight to `fs.readFileSync` and friends.
 */
export interface SiblingHermesHome {
  /** WSL distro name, e.g. "Ubuntu". */
  distro: string;
  /** Linux user the home dir belongs to, e.g. "pmos6". */
  user: string;
  /** UNC-style path to the .hermes directory on the WSL fs, e.g.
   *  `\\wsl$\Ubuntu\home\pmos6\.hermes`. Always uses backslashes
   *  because that's what UNC + Node `fs` expect on Windows. */
  hermesHome: string;
}

/** True iff this is a Windows host with WSL installed. The check is a
 *  pure existsSync — fast, side-effect-free, doesn't wake any
 *  distro. */
export function isWindowsHostWithWsl(): boolean {
  if (!IS_WINDOWS) return false;
  try {
    return existsSync(WSL_EXE);
  } catch {
    return false;
  }
}

/**
 * Enumerate WSL distros visible to the user. Uses the `\\wsl$\` UNC
 * root rather than running `wsl.exe -l` so a stopped distro doesn't
 * get auto-woken (and so a slow WSL service doesn't slow the audit).
 *
 * Returns [] if WSL isn't installed, the UNC root isn't accessible,
 * or anything throws. Cheap to call (~1ms when no WSL, ~10ms with).
 */
export function listWslDistros(): string[] {
  if (!isWindowsHostWithWsl()) return [];
  const wslRoot = "\\\\wsl$\\";
  try {
    if (!existsSync(wslRoot)) return [];
    return readdirSync(wslRoot).filter((name) => {
      try {
        return statSync(join(wslRoot, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Find every accessible sibling `~/.hermes/` across all WSL distros.
 * Walks each distro's `/home/<user>/.hermes` and yields one entry per
 * existing dir.
 *
 * Performance: filesystem-only, no subprocess. Each distro contributes
 * one `readdirSync` of `/home/`. Cached for `CACHE_TTL_MS` so the
 * audit doesn't re-walk on every panel render.
 */
const CACHE_TTL_MS = 60 * 1000;
let _cache: { ts: number; result: SiblingHermesHome[] } | null = null;

export function findSiblingHermesHomes(): SiblingHermesHome[] {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL_MS) {
    return _cache.result;
  }
  const result: SiblingHermesHome[] = [];
  try {
    for (const distro of listWslDistros()) {
      const homesRoot = `\\\\wsl$\\${distro}\\home`;
      let users: string[] = [];
      try {
        if (!existsSync(homesRoot)) continue;
        users = readdirSync(homesRoot);
      } catch {
        continue;
      }
      for (const user of users) {
        const hermesHome = `\\\\wsl$\\${distro}\\home\\${user}\\.hermes`;
        try {
          if (
            existsSync(hermesHome) &&
            statSync(hermesHome).isDirectory()
          ) {
            result.push({ distro, user, hermesHome });
          }
        } catch {
          // distro stopped or permission-denied — skip silently
        }
      }
    }
  } catch {
    // any unexpected error → empty result, never blocks the audit
  }
  _cache = { ts: Date.now(), result };
  return result;
}

/** Test-only — clear the cache so repeat invocations re-walk the fs. */
export function _clearWslCache(): void {
  _cache = null;
}

/**
 * Best-effort `wsl --status` check. Used only for diagnostic display;
 * not on the hot path of `findSiblingHermesHomes`. Returns the raw
 * output (trimmed) or null on any error.
 */
export function wslStatus(): string | null {
  if (!isWindowsHostWithWsl()) return null;
  try {
    const out = execFileSync(WSL_EXE, ["--status"], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    return String(out).trim();
  } catch {
    return null;
  }
}
