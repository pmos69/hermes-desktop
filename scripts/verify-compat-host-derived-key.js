/**
 * Live-verify the dual-engine compat fix for host-derived <VENDOR>_API_KEY.
 *
 * Two paths needed compat:
 *   1. CLI runtime spawn (`sendMessageViaCli`) — writes both
 *      OPENAI_API_KEY (old engine) and <VENDOR>_API_KEY (new engine) into
 *      the child process env at chat-send time.
 *   2. Gateway persistence (`models.ts::seedDefaults`) — writes both
 *      CUSTOM_PROVIDER_<NAME>_KEY (historical) and <VENDOR>_API_KEY
 *      (new engine) into ~/.hermes/.env so the long-running gateway,
 *      which only sees .env at startGateway time, has the right key.
 *
 * This script verifies (2) by:
 *   - Appending a custom_providers entry to the active HERMES_HOME's
 *     config.yaml (api.deepseek.com with a fake key)
 *   - Triggering listModels() via IPC (causes seedDefaults to run)
 *   - Reading .env back and asserting BOTH env-var names are present
 *
 * (1) is covered by `tests/compat-host-derived-key.test.ts` (URL → envvar
 * mapping) — the call-site uses the same helper.
 *
 * Run against both engines:
 *   $env:HERMES_HOME="$env:LocalAppData\hermes-oldengine"; $env:ENABLE_CDP=1; npm run dev
 *   node scripts/verify-compat-host-derived-key.js
 *   # then restart with HERMES_HOME=hermes-newengine and re-run.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const FAKE_KEY = "sk-fake-deepseek-compat-test-12345";
const PROVIDER_NAME = "CompatTestDeepseek";
const BASE_URL = "https://api.deepseek.com/v1";

async function attach() {
  const cdpUrl = `http://127.0.0.1:${process.env.CDP_PORT || "9222"}`;
  const browser = await chromium.connectOverCDP(cdpUrl);
  const page = browser.contexts()[0].pages()[0];
  return { browser, page };
}

(async () => {
  const { browser, page } = await attach();

  // Phase A — observe HERMES_HOME + engine version
  const home = await page.evaluate(
    async () => await window.hermesAPI.getHermesHome(),
  );
  const engine = await page.evaluate(
    async () => await window.hermesAPI.getHermesVersion(),
  );
  console.log("HERMES_HOME:", home);
  console.log("Engine:    ", engine);
  const flavor = home.toLowerCase().includes("hermes-oldengine")
    ? "OLD"
    : home.toLowerCase().includes("hermes-newengine")
      ? "NEW"
      : "DEFAULT";
  console.log("Test leg:  ", flavor);

  const cfgFile = path.join(home, "config.yaml");
  const envFile = path.join(home, ".env");

  // Phase B — append custom_providers entry to config.yaml (if not present)
  const cfg = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, "utf-8") : "";
  if (!cfg.includes(PROVIDER_NAME)) {
    const append =
      "\ncustom_providers:\n" +
      `  - name: "${PROVIDER_NAME}"\n` +
      `    model: "deepseek-chat"\n` +
      `    base_url: "${BASE_URL}"\n` +
      `    api_key: "${FAKE_KEY}"\n`;
    fs.writeFileSync(cfgFile, cfg + append);
    console.log("[B] Appended custom_providers entry to config.yaml");
  } else {
    console.log("[B] config.yaml already has", PROVIDER_NAME, "— continuing");
  }

  // Phase C — force a fresh seedDefaults so .env gets re-persisted.
  // The desktop seeds when listModels has no models.json. Easiest:
  // delete models.json, then list.
  const modelsFile = path.join(home, "models.json");
  if (fs.existsSync(modelsFile)) {
    fs.unlinkSync(modelsFile);
    console.log("[C] Deleted models.json to force re-seed");
  }
  const listed = await page.evaluate(
    async () => await window.hermesAPI.listModels(),
  );
  const found = listed.find((m) => m.name === PROVIDER_NAME);
  console.log(
    "[C] listModels picked up entry:",
    found ? `id=${found.id}, baseUrl=${found.baseUrl}` : "✗ MISSING",
  );

  // Phase D — read .env and assert both env-var names are written
  const envContent = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf-8") : "";
  const customPrefixKey = `CUSTOM_PROVIDER_${PROVIDER_NAME.toUpperCase()}_KEY`;
  const hasCustomPrefix = new RegExp(`^${customPrefixKey}=${FAKE_KEY}$`, "m").test(
    envContent,
  );
  const hasHostDerived = new RegExp(`^DEEPSEEK_API_KEY=${FAKE_KEY}$`, "m").test(
    envContent,
  );

  console.log("\n[D] .env contents (relevant lines):");
  for (const line of envContent.split("\n")) {
    if (/DEEPSEEK|CUSTOM_PROVIDER_COMPAT/.test(line)) {
      console.log("  ", line);
    }
  }

  console.log("\n=== VERDICT ===");
  console.log(`  ${customPrefixKey}=${FAKE_KEY}: ${hasCustomPrefix ? "✓" : "✗"}`);
  console.log(`  DEEPSEEK_API_KEY=${FAKE_KEY}:                ${hasHostDerived ? "✓" : "✗"}`);
  if (hasCustomPrefix && hasHostDerived) {
    console.log(
      `\n✅ PASS (${flavor} engine): both env-var names persisted to .env.`,
    );
    console.log(
      "   → The long-running gateway will find DEEPSEEK_API_KEY on next startup.",
    );
    console.log(
      "   → On the new engine, _host_derived_api_key() can resolve it.",
    );
  } else if (hasCustomPrefix && !hasHostDerived) {
    console.log(
      `\n❌ FAIL (${flavor} engine): only the custom-prefix form was persisted.`,
    );
    console.log(
      "   → The new engine's host-derive resolver won't find a key for this provider.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      `\n❌ FAIL (${flavor} engine): missing one or both env-var names.`,
    );
    process.exitCode = 2;
  }

  // Phase E — teardown
  console.log("\n[E] Removing test custom-provider entry…");
  const cfgAfter = fs.readFileSync(cfgFile, "utf-8");
  const cleanedCfg = cfgAfter.replace(
    /\ncustom_providers:[\s\S]*?(?=\n[a-z_]+\s*:|$)/,
    "",
  );
  fs.writeFileSync(cfgFile, cleanedCfg);

  // Also wipe the two env vars we just wrote
  const cleanedEnv = envContent
    .split("\n")
    .filter(
      (l) =>
        !l.startsWith(customPrefixKey + "=") &&
        !l.startsWith(`DEEPSEEK_API_KEY=${FAKE_KEY}`),
    )
    .join("\n");
  fs.writeFileSync(envFile, cleanedEnv);
  console.log("Cleanup done.");

  await browser.close();
})().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(3);
});
