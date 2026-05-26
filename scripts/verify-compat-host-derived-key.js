/**
 * Live-verify the dual-engine compat fix for host-derived <VENDOR>_API_KEY.
 *
 * Confirms that when the desktop spawns the hermes-agent subprocess for a
 * custom-provider chat against a known-vendor host (e.g. api.deepseek.com),
 * the child env contains BOTH:
 *   - OPENAI_API_KEY (so old engine v2026.5.16 / v0.14.0 keeps working)
 *   - <VENDOR>_API_KEY (so post-2026.5.16 engines with
 *     hermes_cli/runtime_provider.py::_host_derived_api_key find a key)
 *
 * Probe strategy: seed a custom_providers.json with a fake-key deepseek
 * provider, kick a chat via IPC, and capture the gateway error. With the
 * fix in place:
 *
 *   - Old engine (v2026.5.16): reads OPENAI_API_KEY, forwards to
 *     api.deepseek.com, deepseek returns 401 "Invalid API key" — key
 *     reached the API.
 *   - New engine (post-host-derive): reads DEEPSEEK_API_KEY via host-derive,
 *     forwards to api.deepseek.com, same 401 from deepseek.
 *
 * Without the fix on a host-derive-aware engine: chat fails earlier with
 * "no-key-required" or missing-key error before reaching deepseek.
 *
 * Prereqs:
 *   1. Dev electron running with ENABLE_CDP=1 (port 9222 by default)
 *   2. Main process built from `fix/compat-host-derived-api-key` branch
 *   3. For the "old engine" leg: HERMES_HOME=%LocalAppData%/hermes-oldengine
 *      (set BEFORE `npm run dev` — see .personal/engine-update-audit.md
 *      Phase 0 for setup instructions)
 *   4. For the "new engine" leg: HERMES_HOME=%LocalAppData%/hermes-newengine
 *
 * Run:   node scripts/verify-compat-host-derived-key.js
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const os = require("os");

const FAKE_KEY = "sk-fake-deepseek-compat-test-12345";
const PROVIDER_NAME = "_compat_test_deepseek";
const BASE_URL = "https://api.deepseek.com/v1";

async function attach() {
  const cdpUrl = `http://127.0.0.1:${process.env.CDP_PORT || "9222"}`;
  const browser = await chromium.connectOverCDP(cdpUrl);
  const page = browser.contexts()[0].pages()[0];
  return { browser, page };
}

(async () => {
  const { browser, page } = await attach();

  // Phase A — observe which engine + HERMES_HOME the desktop is wired to
  const home = await page.evaluate(
    async () => await window.hermesAPI.getHermesHome(),
  );
  const engine = await page.evaluate(
    async () => await window.hermesAPI.getHermesVersion(),
  );
  console.log("HERMES_HOME:", home);
  console.log("Engine version:", engine);
  const isOldEngine = home.toLowerCase().includes("hermes-oldengine");
  const isNewEngine = home.toLowerCase().includes("hermes-newengine");
  const flavor = isOldEngine ? "OLD" : isNewEngine ? "NEW" : "DEFAULT";
  console.log(`Test leg: ${flavor}`);

  // Phase B — seed a custom provider via direct JSON write (no add-provider
  // IPC exists in the renderer surface; the desktop loads custom_providers.json
  // on the next listModels call).
  const cpFile = path.join(home, "custom_providers.json");
  let cps = [];
  if (fs.existsSync(cpFile)) {
    try {
      cps = JSON.parse(fs.readFileSync(cpFile, "utf-8"));
    } catch {
      cps = [];
    }
  }
  const existing = cps.findIndex((c) => c.name === PROVIDER_NAME);
  const entry = {
    name: PROVIDER_NAME,
    provider: "custom",
    model: "deepseek-chat",
    baseUrl: BASE_URL,
    apiKey: FAKE_KEY,
    apiMode: null,
  };
  if (existing >= 0) cps[existing] = entry;
  else cps.push(entry);
  fs.writeFileSync(cpFile, JSON.stringify(cps, null, 2));
  console.log(`[B] Seeded ${PROVIDER_NAME} → ${BASE_URL} into ${cpFile}`);

  // Trigger a listModels so the desktop picks up the new entry and writes
  // the CUSTOM_PROVIDER_<NAME>_KEY env var into .env.
  const modelsAfter = await page.evaluate(
    async () => await window.hermesAPI.listModels(),
  );
  const seeded = modelsAfter.find((m) => m.name === PROVIDER_NAME);
  console.log(
    "[B] listModels picked up entry:",
    seeded ? `id=${seeded.id}` : "NO (failed to seed)",
  );

  // Phase C — activate the provider + send chat
  console.log("\n[C] Activating provider + sending probe chat…");
  await page.evaluate(
    async ({ provider, model, baseUrl }) => {
      await window.hermesAPI.setModelConfig(provider, model, baseUrl);
    },
    { provider: "custom", model: "deepseek-chat", baseUrl: BASE_URL },
  );

  let chatError = null;
  let chatResult = null;
  try {
    chatResult = await page.evaluate(async () => {
      // Pre-2026.5.16 sendMessage signature: (message, profile?, resumeSessionId?, history?, attachments?, contextFolder?)
      return await window.hermesAPI.sendMessage("ping", undefined);
    });
  } catch (e) {
    chatError = e.message || String(e);
  }
  const response =
    (chatResult && JSON.stringify(chatResult)) || chatError || "(no output)";
  console.log("\nResponse (truncated):", response.slice(0, 600));

  // Phase D — verdict
  const looksLikeDeepseekAuth = /401|Invalid.*[Aa]uthentication|invalid.*api.key/i.test(
    response,
  );
  const looksLikeNoKey = /no.key.required|missing.*key|require.*api.key/i.test(
    response,
  );

  console.log("\n=== VERDICT ===");
  if (looksLikeDeepseekAuth) {
    console.log(
      `✅ PASS (${flavor} engine): key reached api.deepseek.com (401/auth-error).`,
    );
    console.log(
      "   → Proves the desktop wrote the correct env var for this engine version.",
    );
  } else if (looksLikeNoKey) {
    console.log(
      `❌ FAIL (${flavor} engine): chat failed BEFORE reaching deepseek (missing-key).`,
    );
    if (flavor === "NEW") {
      console.log(
        "   → New engine couldn't find DEEPSEEK_API_KEY. Compat fix not active.",
      );
    } else {
      console.log("   → Investigate — this shouldn't happen on the old engine.");
    }
    process.exitCode = 1;
  } else {
    console.log(
      `⚠️  AMBIGUOUS (${flavor} engine): response doesn't clearly match auth-401 or no-key.`,
    );
    console.log("   Full response above. Manually classify.");
    process.exitCode = 2;
  }

  // Phase E — teardown: remove the seeded entry, write back custom_providers.json
  console.log("\n[E] Removing seeded provider…");
  const remaining = cps.filter((c) => c.name !== PROVIDER_NAME);
  if (remaining.length === 0 && fs.existsSync(cpFile)) {
    fs.unlinkSync(cpFile);
  } else {
    fs.writeFileSync(cpFile, JSON.stringify(remaining, null, 2));
  }
  // Also wipe the CUSTOM_PROVIDER_<NAME>_KEY env var line the desktop wrote.
  const envFile = path.join(home, ".env");
  if (fs.existsSync(envFile)) {
    const sanitizedName = PROVIDER_NAME.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
    const envKey = `CUSTOM_PROVIDER_${sanitizedName}_KEY`;
    const content = fs.readFileSync(envFile, "utf-8");
    const cleaned = content
      .split("\n")
      .filter((l) => !l.startsWith(envKey + "="))
      .join("\n");
    fs.writeFileSync(envFile, cleaned);
  }
  console.log("Cleanup done.");

  await browser.close();
})().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(3);
});
