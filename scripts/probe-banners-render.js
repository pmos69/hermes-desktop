/**
 * Verify the renderer-side banners render when the underlying state
 * dictates they should. This drives the actual DOM, not just the IPC.
 */
const { attach } = require("./e2e-attach");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ENV_FILE = path.join(os.homedir(), "AppData", "Local", "hermes", ".env");
const ENV_BACKUP = ENV_FILE + ".banner-probe-bk";

(async () => {
  const { browser, page } = await attach();

  // Make sure we're on the Chat tab
  await page.click('text=/^Chat$/').catch(() => {});
  await new Promise((r) => setTimeout(r, 400));

  // A. Inspect the config-health banner at the top of chat
  const banner = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="config-health-banner"]');
    return el
      ? {
          present: true,
          severity: el.className,
          text: (el.textContent || "").trim().slice(0, 200),
        }
      : { present: false };
  });
  console.log("[A] ConfigHealthBanner:", JSON.stringify(banner));

  // B. Trigger validation by removing DEEPSEEK_API_KEY (active provider's key)
  fs.copyFileSync(ENV_FILE, ENV_BACKUP);
  const before = fs.readFileSync(ENV_FILE, "utf-8");
  fs.writeFileSync(ENV_FILE, before.replace(/^DEEPSEEK_API_KEY=.*\n?/m, ""));
  // Bust readEnv cache
  await page.evaluate(async () => {
    await window.hermesAPI.setEnv("__BANNER_PROBE__", String(Date.now()));
  });

  // Force the validation effect to re-run by toggling the model
  // — simplest way: just wait for the next periodic update / nav off-and-back
  await page.click('text=/^Models$/').catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await page.click('text=/^Chat$/').catch(() => {});
  await new Promise((r) => setTimeout(r, 600));

  const readinessBanner = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-readiness-banner"]');
    if (!el) return { present: false };
    return {
      present: true,
      text: (el.textContent || "").trim(),
    };
  });
  console.log("[B] chat-readiness-banner:", JSON.stringify(readinessBanner));

  // C. Send button should be disabled
  const sendBtnState = await page.evaluate(() => {
    const btn = document.querySelector(".chat-send-btn:not(.chat-stop-btn)");
    return btn ? { disabled: btn.disabled, title: btn.getAttribute("title") } : null;
  });
  console.log("[C] Send button:", JSON.stringify(sendBtnState));

  // Restore .env
  fs.copyFileSync(ENV_BACKUP, ENV_FILE);
  fs.unlinkSync(ENV_BACKUP);
  await page.evaluate(async () => {
    await window.hermesAPI.setEnv("__BANNER_PROBE__", "");
  });

  // Verdicts
  const aOk = banner.present; // config-health banner showed
  const bOk = readinessBanner.present &&
    readinessBanner.text.includes("DEEPSEEK_API_KEY");
  const cOk = sendBtnState && sendBtnState.disabled === true;
  console.log();
  console.log(`[VERDICT A] ${aOk ? "✅" : "⚠️"} ConfigHealthBanner ${aOk ? "rendered" : "not visible (may be dismissed or no issues currently)"}`);
  console.log(`[VERDICT B] ${bOk ? "✅" : "🔴"} chat-readiness-banner rendered with expected env key`);
  console.log(`[VERDICT C] ${cOk ? "✅" : "🔴"} Send button is disabled when readiness blocks`);

  await browser.close();
})().catch((e) => {
  try {
    if (fs.existsSync(ENV_BACKUP)) {
      fs.copyFileSync(ENV_BACKUP, ENV_FILE);
      fs.unlinkSync(ENV_BACKUP);
    }
  } catch {}
  console.error("FAILED:", e.stack || e.message || e);
  process.exit(1);
});
