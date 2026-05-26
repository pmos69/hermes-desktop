/**
 * Reproduce PR #376's duplicate-messages bug.
 *
 * Method:
 *   1. New chat.
 *   2. Send a message that the agent's reply will echo (forces stream-vs-DB
 *      whitespace divergence to be a real possibility).
 *   3. Wait for chat-done (which triggers reconcileStreamedWithDb).
 *   4. Count bubbles by role+content. Each (role, content) tuple should
 *      appear exactly once.
 *
 * Pre-fix: at least one duplicate (same role+content twice in DOM).
 * Post-fix: each tuple appears exactly once.
 */
const { attach } = require("./e2e-attach");

const PROMPT = "Reply with exactly the following three short lines, each separated by a blank line:\n\nFirst line.\n\nSecond line.\n\nThird line.";

(async () => {
  const { browser, page } = await attach();
  // New chat
  await page.click("button.chat-clear-btn").catch(() => {});
  await new Promise((r) => setTimeout(r, 400));

  // Snapshot bubble count
  const prevCount = await page.evaluate(
    () =>
      document.querySelectorAll(".chat-bubble-user, .chat-bubble-agent").length,
  );
  console.log(`[setup] bubbles before send: ${prevCount}`);

  // Send the message
  await page.fill("textarea.chat-input", PROMPT);
  await page.keyboard.press("Enter");

  // Wait for streaming to finish (stop button disappears, agent bubble appears)
  await page.waitForFunction(
    () => {
      const stop = document.querySelector(".chat-stop-btn");
      const agents = document.querySelectorAll(".chat-bubble-agent").length;
      return !stop && agents > 0;
    },
    null,
    { timeout: 90_000, polling: 250 },
  );
  // Give the post-stream reconcile + render a beat to settle
  await new Promise((r) => setTimeout(r, 1200));

  // Snapshot the current bubble list
  const bubbles = await page.evaluate(() => {
    const all = [
      ...document.querySelectorAll(".chat-bubble-user, .chat-bubble-agent"),
    ];
    return all.map((el) => ({
      role: el.classList.contains("chat-bubble-user") ? "user" : "agent",
      text: (el.textContent || "").trim().slice(0, 80),
      id: el.getAttribute("data-message-id") || null,
    }));
  });

  // Look for exact-content duplicates per role
  const seen = new Map();
  const dups = [];
  for (const b of bubbles) {
    const k = `${b.role}|${b.text}`;
    if (seen.has(k)) {
      dups.push({ role: b.role, text: b.text, count: 2 });
    } else {
      seen.set(k, b);
    }
  }

  console.log(`[step 3] total bubbles after: ${bubbles.length}`);
  console.log(`[step 3] unique (role, text) tuples: ${seen.size}`);
  console.log(`[step 3] bubble list:`);
  for (const b of bubbles) {
    console.log(
      `           [${b.role}] id=${b.id || "?"} "${b.text.replace(/\n/g, " ").slice(0, 70)}"`,
    );
  }

  if (dups.length > 0) {
    console.log(`\n[VERDICT] 🔴 REPRODUCED — duplicate bubble(s):`);
    for (const d of dups) {
      console.log(`           [${d.role}] "${d.text.slice(0, 60)}" — ${d.count}x`);
    }
  } else {
    console.log(`\n[VERDICT] ✅ No duplicates — each bubble appears once.`);
  }

  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message || e);
  process.exit(1);
});
