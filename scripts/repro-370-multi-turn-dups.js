/**
 * Reproduce issue #370 — duplicate assistant responses after each new
 * chat turn. Reporter on macOS sees them consistently with DeepSeek
 * v4-pro. Per the diagnosis in the issue, the trigger is whitespace
 * divergence between the streamed content and the DB-persisted
 * content of an earlier turn — the reconciliation key in
 * sessionHistory.ts doesn't normalise whitespace, so a later
 * reconcileStreamedWithDb() call pushes the unmatched DB row as a
 * "new" message.
 *
 * Method:
 *   1. New chat.
 *   2. Send Turn 1. Wait for streaming to finish. Snapshot bubble
 *      count.
 *   3. Send Turn 2. Wait for streaming to finish. Snapshot bubbles.
 *   4. After turn N, expected bubble count is 2*N (each turn adds 1
 *      user + 1 agent). If a duplicate is appended, count > 2*N.
 *   5. Check for exact text duplicates by role + content.
 */
const { attach } = require("./e2e-attach");

const PROMPTS = [
  "Reply with exactly: 'PONG-ONE'. Nothing else.",
  "Reply with exactly: 'PONG-TWO'. Nothing else.",
  "Reply with exactly: 'PONG-THREE'. Nothing else.",
];

(async () => {
  const { browser, page } = await attach();
  await page.click("button.chat-clear-btn").catch(() => {});
  await new Promise((r) => setTimeout(r, 400));

  const bubbleCounts = [0];
  let dupes = [];

  for (let i = 0; i < PROMPTS.length; i++) {
    const before = await page.evaluate(
      () => document.querySelectorAll(".chat-bubble-user, .chat-bubble-agent").length,
    );
    console.log(`[turn ${i + 1}] sending: ${PROMPTS[i]}`);
    await page.fill("textarea.chat-input", PROMPTS[i]);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (prev) => {
        const stop = document.querySelector(".chat-stop-btn");
        const agents = document.querySelectorAll(".chat-bubble-agent").length;
        return !stop && agents > prev;
      },
      Math.floor(before / 2),
      { timeout: 90_000, polling: 250 },
    );
    // Let onChatDone + reconcileStreamedWithDb settle
    await new Promise((r) => setTimeout(r, 1500));

    const bubbles = await page.evaluate(() => {
      const all = [
        ...document.querySelectorAll(".chat-bubble-user, .chat-bubble-agent"),
      ];
      return all.map((el) => ({
        role: el.classList.contains("chat-bubble-user") ? "user" : "agent",
        text: (el.textContent || "").trim().slice(0, 120),
      }));
    });
    bubbleCounts.push(bubbles.length);
    console.log(`[turn ${i + 1}] total bubbles: ${bubbles.length} (expected ${2 * (i + 1)})`);

    // Detect content-level duplicates by (role, text) tuple
    const seen = new Map();
    for (const b of bubbles) {
      const k = `${b.role}|${b.text}`;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    for (const [k, count] of seen) {
      if (count > 1) dupes.push({ turn: i + 1, key: k, count });
    }
  }

  await browser.close();

  console.log();
  console.log("─".repeat(70));
  console.log(`Bubble counts per turn:`, bubbleCounts.slice(1).join(", "));
  console.log(`Expected:`, PROMPTS.map((_, i) => 2 * (i + 1)).join(", "));
  console.log();

  if (dupes.length > 0) {
    console.log(`[VERDICT] 🔴 REPRODUCED — duplicate (role, text) tuples observed:`);
    for (const d of dupes) {
      console.log(`           turn ${d.turn}: ${d.key.slice(0, 80)} (×${d.count})`);
    }
  } else if (bubbleCounts[bubbleCounts.length - 1] > 2 * PROMPTS.length) {
    console.log(`[VERDICT] ⚠️  Bubble count exceeded expected — possible duplicate of slightly-different content.`);
  } else {
    console.log(`[VERDICT] ✅ No duplicates in this environment.`);
    console.log(`           Note: the bug is whitespace-divergence-sensitive between`);
    console.log(`           streamed text and DB-persisted text. May not reproduce on`);
    console.log(`           every host/model combination.`);
  }
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message || e);
  process.exit(1);
});
