/**
 * Config-health audit — startup + on-demand scan for inconsistencies
 * across the desktop's three configuration surfaces (`.env`,
 * `config.yaml`, `models.json`) plus the running gateway state.
 *
 * Every check is wrapped in try/catch so a broken check NEVER breaks
 * the audit; the runner returns an empty report on total failure.
 * Each issue carries an `autoFixable` flag and a fix description; the
 * renderer's Diagnose UI renders a per-issue "Fix" button for those.
 *
 * Audit log: every auto-fix appends to `~/.hermes/logs/config-fixes.log`
 * via `appendConfigFixLog` (capped at 1000 entries).
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { profilePaths } from "./utils";
import {
  type ApiKeySource,
  appendConfigFixLog,
  getConfigValue,
  getModelConfig,
  hasOAuthCredentials,
  maskKey,
  readEnv,
  setEnvValue,
} from "./config";
import { HERMES_HOME } from "./installer";
import { expectedEnvKeyForModel } from "./installer";
import { expectedEnvKeyForUrl } from "../shared/url-key-map";

export type Severity = "error" | "warning" | "info";

export type IssueCode =
  | "API_SERVER_KEY_NON_CANONICAL"
  | "API_SERVER_KEY_MULTIPLE_VALUES"
  | "EMPTY_API_SERVER_KEY"
  | "MODEL_KEY_MISSING"
  | "UI_RUNTIME_ENVKEY_MISMATCH"
  | "NON_ASCII_CREDENTIAL";

export interface ConfigHealthIssue {
  code: IssueCode;
  severity: Severity;
  message: string;
  detail?: string;
  /** Filesystem paths involved — shown to the user verbatim. */
  locations: string[];
  autoFixable: boolean;
  fixDescription?: string;
  fixLocation?: "providers" | "models" | ".env" | "config.yaml" | "setup";
  /** Optional context for the auto-fix routine (e.g. which env var). */
  context?: Record<string, string>;
}

export interface ConfigHealthReport {
  ranAt: number;
  profile: string;
  issues: ConfigHealthIssue[];
  summary: { errors: number; warnings: number; infos: number };
}

const EMPTY_REPORT = (profile: string): ConfigHealthReport => ({
  ranAt: Date.now(),
  profile,
  issues: [],
  summary: { errors: 0, warnings: 0, infos: 0 },
});

/**
 * Run all enabled checks against the given profile (default profile
 * when omitted). Returns a populated report; never throws.
 */
export function runConfigHealthCheck(
  profile?: string,
): ConfigHealthReport {
  const profileName = profile || "default";
  const report = EMPTY_REPORT(profileName);

  const checks: Array<(p?: string) => ConfigHealthIssue[]> = [
    checkApiServerKeyPlacement,
    checkActiveModelKeyPresence,
    checkRuntimeEnvKeyMismatch,
    checkNonAsciiCredentials,
  ];

  for (const check of checks) {
    try {
      const issues = check(profile);
      for (const issue of issues) {
        report.issues.push(issue);
        if (issue.severity === "error") report.summary.errors++;
        else if (issue.severity === "warning") report.summary.warnings++;
        else report.summary.infos++;
      }
    } catch (err) {
      // Swallow — a broken check never breaks the audit. Log to console
      // so a developer can find it; users see only the empty result.
      // eslint-disable-next-line no-console
      console.warn("[config-health] check threw:", err);
    }
  }

  return report;
}

/**
 * Auto-fix dispatcher. Each fixable IssueCode has its own handler.
 * Returns `{ok: false}` for unknown / non-fixable codes.
 */
export function autoFixIssue(
  code: IssueCode,
  profile?: string,
  context?: Record<string, string>,
): { ok: boolean; message?: string } {
  try {
    switch (code) {
      case "API_SERVER_KEY_NON_CANONICAL":
        return fixApiServerKeyPlacement(profile);
      case "UI_RUNTIME_ENVKEY_MISMATCH":
        return fixRuntimeEnvKeyMismatch(profile, context);
      case "NON_ASCII_CREDENTIAL":
        return fixNonAsciiCredential(profile, context);
      default:
        return { ok: false, message: `No auto-fix available for ${code}` };
    }
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

// ───────────────────────────────────────────────────────
//  Checks
// ───────────────────────────────────────────────────────

/**
 * `API_SERVER_KEY` lives in any non-`.env` location AND/OR in multiple
 * locations with different values. The migration-on-read fix in
 * getApiServerKey() handles the first case automatically; this check
 * just surfaces it so users see it happened (and re-fires if the auto
 * migration failed for some reason).
 */
function checkApiServerKeyPlacement(profile?: string): ConfigHealthIssue[] {
  const issues: ConfigHealthIssue[] = [];
  const { envFile, configFile } = profilePaths(profile);

  const env = readEnv(profile);
  const envKey = (env.API_SERVER_KEY ?? "").trim();
  const topLevel = (getConfigValue("API_SERVER_KEY", profile) ?? "").trim();
  const nested = (getConfigValue("api_server.token", profile) ?? "").trim();

  // Multiple values: if two or more non-empty locations disagree, that's
  // ambiguous and the user has to resolve which one wins.
  const values = [envKey, topLevel, nested].filter((v) => v !== "");
  const uniqueValues = new Set(values);
  if (uniqueValues.size > 1) {
    issues.push({
      code: "API_SERVER_KEY_MULTIPLE_VALUES",
      severity: "error",
      message:
        "API_SERVER_KEY is set in multiple places with different values.",
      detail:
        "The desktop and the gateway pick different values depending on " +
        "the source. Resolve to a single canonical entry in .env and " +
        "remove the others.",
      locations: [envFile, configFile].filter(existsSync),
      autoFixable: false,
      fixLocation: ".env",
    });
    return issues; // Resolve this before re-flagging non-canonical placement
  }

  // Non-canonical placement: the only value is somewhere other than .env.
  if (!envKey && (topLevel || nested)) {
    const source: ApiKeySource = topLevel
      ? "configTopLevelProfile"
      : "apiServerTokenProfile";
    issues.push({
      code: "API_SERVER_KEY_NON_CANONICAL",
      severity: "warning",
      message:
        "API_SERVER_KEY is configured in config.yaml only — copy it to .env so the gateway picks it up reliably.",
      detail:
        "The upstream gateway reads API_SERVER_KEY from .env or its " +
        "spawn environment. Keeping the value in config.yaml works " +
        "today (the desktop bridges it), but .env is the canonical " +
        "location and survives upstream changes.",
      locations: [configFile].filter(existsSync),
      autoFixable: true,
      fixDescription: "Copy the value into .env (config.yaml untouched).",
      fixLocation: ".env",
      context: { source },
    });
  }

  // Empty: no key at all, and the gateway is configured to require one.
  // We can't auto-fix this — the user has to provide a secret.
  if (!envKey && !topLevel && !nested) {
    // Only flag if a gateway run.py / api_server is actually configured.
    // For a fresh install with no setup yet, this would be noise.
    const configExists = existsSync(configFile);
    if (configExists) {
      issues.push({
        code: "EMPTY_API_SERVER_KEY",
        severity: "info",
        message:
          "No API_SERVER_KEY is set — session continuation will use the gateway's anonymous fallback.",
        detail:
          "If you want to enforce auth on the local gateway (or are " +
          "running it remotely / behind SSH), set API_SERVER_KEY in .env.",
        locations: [envFile],
        autoFixable: false,
        fixLocation: "setup",
      });
    }
  }

  return issues;
}

/**
 * Active model is configured but its expected provider key isn't in
 * .env. This is the *most likely* cause of chat 401s — the user has
 * picked a model in the GUI but their key isn't where the gateway
 * expects to find it.
 */
function checkActiveModelKeyPresence(profile?: string): ConfigHealthIssue[] {
  const mc = getModelConfig(profile);
  if (!mc.provider || mc.provider === "auto") return [];
  if (!mc.model) return [];

  // Localhost / OAuth providers don't need a key.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(mc.baseUrl)) return [];

  const expectedKey = expectedEnvKeyForModel(mc.provider, mc.baseUrl);
  if (!expectedKey) return [];

  const env = readEnv(profile);
  if (((env[expectedKey] ?? "")).trim()) return [];

  // Secondary positive signal: auth.json may carry the credentials
  // (OAuth tokens, or properly-shaped credential-pool entries).
  // Issue #367 — Nous Portal in OAuth mode has no NOUS_API_KEY in
  // .env, the engine resolves from auth.json instead. Don't flag if
  // we see real evidence there.
  if (hasOAuthCredentials(mc.provider, profile)) return [];

  const { envFile } = profilePaths(profile);
  return [
    {
      code: "MODEL_KEY_MISSING",
      severity: "warning",
      message: `Active model uses ${mc.provider} but ${expectedKey} is not set in .env (and no credentials in auth.json).`,
      detail:
        "Chat will fail with an upstream auth error until the key is " +
        "configured. Add it under Providers, sign in via the OAuth " +
        "flow, or switch to a model whose credentials are already set.",
      locations: [envFile],
      autoFixable: false,
      fixLocation: "providers",
      context: { expectedKey, provider: mc.provider },
    },
  ];
}

/**
 * Mismatch between the env var name the GUI saved a key under and the
 * env var name the runtime actually reads. Specifically: the user
 * picked a base URL whose canonical key is X, but their .env stores
 * a value under Y. Auto-fix copies the value to X (Option A — leave
 * the old entry alone).
 */
function checkRuntimeEnvKeyMismatch(
  profile?: string,
): ConfigHealthIssue[] {
  const mc = getModelConfig(profile);
  if (!mc.baseUrl) return [];

  const expectedKey = expectedEnvKeyForUrl(mc.baseUrl);
  if (expectedKey === "CUSTOM_API_KEY") return [];

  const env = readEnv(profile);
  const expectedValue = (env[expectedKey] ?? "").trim();
  if (expectedValue) return []; // Expected key already has a value

  // Look for any non-empty *_API_KEY / *_TOKEN that *isn't* the expected
  // one — that's the candidate for the mismatch warning. Don't fire
  // on a wholly-empty .env; that's MODEL_KEY_MISSING territory.
  const candidates = Object.entries(env).filter(
    ([k, v]) =>
      /^[A-Z][A-Z0-9_]*(_API_KEY|_TOKEN)$/.test(k) &&
      k !== expectedKey &&
      k !== "API_SERVER_KEY" &&
      (v ?? "").trim() !== "",
  );
  if (candidates.length === 0) return [];

  // Pick the candidate that looks most like a provider key (first match).
  const [otherKey] = candidates[0];
  const { envFile } = profilePaths(profile);
  return [
    {
      code: "UI_RUNTIME_ENVKEY_MISMATCH",
      severity: "warning",
      message: `${expectedKey} is empty but ${otherKey} has a value — likely saved under the wrong name.`,
      detail:
        `Your active model's base URL (${mc.baseUrl}) expects ${expectedKey}, ` +
        `but only ${otherKey} is populated. Auto-fix copies the value across ` +
        "(the original entry is left alone).",
      locations: [envFile],
      autoFixable: true,
      fixDescription: `Copy ${otherKey} → ${expectedKey} in .env.`,
      fixLocation: ".env",
      context: { from: otherKey, to: expectedKey },
    },
  ];
}

/**
 * Non-ASCII characters in credential values — most often a stray curly
 * quote from a copy-paste, which the upstream rejects with a confusing
 * error. Auto-fix strips them.
 */
function checkNonAsciiCredentials(profile?: string): ConfigHealthIssue[] {
  const env = readEnv(profile);
  const offenders: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*(_API_KEY|_TOKEN|API_SERVER_KEY)$/.test(key)) {
      continue;
    }
    if (!value) continue;
    // eslint-disable-next-line no-control-regex
    if (/[^\x20-\x7e]/.test(value)) {
      offenders.push(key);
    }
  }
  if (offenders.length === 0) return [];

  const { envFile } = profilePaths(profile);
  return [
    {
      code: "NON_ASCII_CREDENTIAL",
      severity: "info",
      message: `Non-ASCII characters detected in: ${offenders.join(", ")}.`,
      detail:
        "Common cause: a smart-quote or trailing newline from a paste. " +
        "Auto-fix strips characters outside the printable ASCII range.",
      locations: [envFile],
      autoFixable: true,
      fixDescription: "Strip non-ASCII characters from the values.",
      fixLocation: ".env",
      context: { keys: offenders.join(",") },
    },
  ];
}

// ───────────────────────────────────────────────────────
//  Auto-fixes
// ───────────────────────────────────────────────────────

function fixApiServerKeyPlacement(profile?: string): {
  ok: boolean;
  message?: string;
} {
  const topLevel = (getConfigValue("API_SERVER_KEY", profile) ?? "").trim();
  const nested = (getConfigValue("api_server.token", profile) ?? "").trim();
  const value = topLevel || nested;
  if (!value) {
    return { ok: false, message: "Nothing to migrate." };
  }
  const env = readEnv(profile);
  if ((env.API_SERVER_KEY ?? "").trim()) {
    return { ok: true, message: ".env already has API_SERVER_KEY." };
  }
  setEnvValue("API_SERVER_KEY", value, profile);
  appendConfigFixLog({
    ts: Date.now(),
    issueCode: "API_SERVER_KEY_NON_CANONICAL",
    action: "autofix",
    from: topLevel ? "configTopLevelProfile" : "apiServerTokenProfile",
    to: profilePaths(profile).envFile,
    profile: profile || "default",
    valueMasked: maskKey(value),
  });
  return { ok: true, message: "Copied API_SERVER_KEY into .env." };
}

function fixRuntimeEnvKeyMismatch(
  profile: string | undefined,
  context: Record<string, string> | undefined,
): { ok: boolean; message?: string } {
  if (!context?.from || !context?.to) {
    return { ok: false, message: "Missing fix context (from/to env keys)." };
  }
  const env = readEnv(profile);
  const value = (env[context.from] ?? "").trim();
  if (!value) {
    return { ok: false, message: `${context.from} is empty — nothing to copy.` };
  }
  if ((env[context.to] ?? "").trim()) {
    return {
      ok: true,
      message: `${context.to} already populated — no copy needed.`,
    };
  }
  setEnvValue(context.to, value, profile);
  appendConfigFixLog({
    ts: Date.now(),
    issueCode: "UI_RUNTIME_ENVKEY_MISMATCH",
    action: "autofix",
    from: context.from,
    to: context.to,
    profile: profile || "default",
    valueMasked: maskKey(value),
  });
  return { ok: true, message: `Copied ${context.from} → ${context.to}.` };
}

function fixNonAsciiCredential(
  profile: string | undefined,
  context: Record<string, string> | undefined,
): { ok: boolean; message?: string } {
  const keys = (context?.keys ?? "").split(",").filter(Boolean);
  if (keys.length === 0) {
    return { ok: false, message: "No keys to clean." };
  }
  const env = readEnv(profile);
  const cleaned: string[] = [];
  for (const key of keys) {
    const value = env[key] ?? "";
    // eslint-disable-next-line no-control-regex
    const stripped = value.replace(/[^\x20-\x7e]/g, "");
    if (stripped !== value && stripped) {
      setEnvValue(key, stripped, profile);
      cleaned.push(key);
      appendConfigFixLog({
        ts: Date.now(),
        issueCode: "NON_ASCII_CREDENTIAL",
        action: "autofix",
        from: key,
        to: key,
        profile: profile || "default",
        valueMasked: maskKey(stripped),
      });
    }
  }
  if (cleaned.length === 0) {
    return { ok: false, message: "Nothing to clean." };
  }
  return { ok: true, message: `Cleaned: ${cleaned.join(", ")}.` };
}

/**
 * Path to the JSONL audit log of all config fixes. Exposed so the
 * Diagnose UI can offer "Show audit log" without reaching into the
 * filesystem from the renderer.
 */
export function configFixLogPath(): string {
  return join(HERMES_HOME, "logs", "config-fixes.log");
}

/**
 * Read the last N entries of the config-fix audit log. Returns an
 * empty array if the log doesn't exist. Best-effort — JSON parse
 * errors on individual lines are skipped.
 */
export function readConfigFixLog(maxEntries = 50): unknown[] {
  const file = configFixLogPath();
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const tail = lines.slice(-maxEntries);
    const entries: unknown[] = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
    return entries;
  } catch {
    return [];
  }
}
