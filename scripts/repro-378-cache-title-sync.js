/**
 * Reproduce PR #378's "cache doesn't pick up DB title/model changes" bug.
 *
 * Setup:
 *   1. Backup state.db + sessions.json.
 *   2. Pick a recent session that exists in state.db.
 *   3. UPDATE state.db SET title = 'AFTER_FIX_TITLE_<ts>', model = 'AFTER_FIX_MODEL'.
 *   4. INSERT into sessions.json a row for the same id with title = 'OLD_CACHED_TITLE',
 *      model = 'OLD_CACHED_MODEL', startedAt = <recent>.
 *   5. Set lastSync just below the row's startedAt so the row falls in
 *      the Phase-1 window (startedAt > lastSync - 300).
 *   6. Trigger sync via window.hermesAPI.syncSessions() (or whichever the IPC name is).
 *   7. Read sessions.json — does the cached row's title/model match what we put in DB?
 *
 * Pre-fix (without #378): title stays "OLD_CACHED_TITLE", model stays "OLD_CACHED_MODEL".
 * Post-fix (with #378): title becomes "AFTER_FIX_TITLE_<ts>", model becomes "AFTER_FIX_MODEL".
 */
const { attach } = require("./e2e-attach");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const STATE_DB = path.join(os.homedir(), "AppData", "Local", "hermes", "state.db");
const CACHE = path.join(os.homedir(), "AppData", "Local", "hermes", "desktop", "sessions.json");
const STATE_BAK = STATE_DB + ".378-bk";
const CACHE_BAK = CACHE + ".378-bk";

function py(code) {
  return execFileSync("python", ["-c", code], { encoding: "utf-8" }).trim();
}

(async () => {
  // 1. Backup
  fs.copyFileSync(STATE_DB, STATE_BAK);
  fs.copyFileSync(CACHE, CACHE_BAK);

  const ts = Date.now();
  const NEW_TITLE = `AFTER_FIX_TITLE_${ts}`;
  const NEW_MODEL = `AFTER_FIX_MODEL_${ts}`;
  const OLD_TITLE = `OLD_CACHED_TITLE_${ts}`;
  const OLD_MODEL = `OLD_CACHED_MODEL_${ts}`;

  // 2. Pick a recent session
  const sessionId = py(`
import sqlite3
db = sqlite3.connect(r"${STATE_DB.replace(/\\/g, "\\\\")}")
row = db.execute("SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1").fetchone()
print(row[0])
`);
  console.log("[setup] target session:", sessionId);

  // 3. Mutate state.db
  py(`
import sqlite3
db = sqlite3.connect(r"${STATE_DB.replace(/\\/g, "\\\\")}")
db.execute("UPDATE sessions SET title = ?, model = ? WHERE id = ?", ("${NEW_TITLE}", "${NEW_MODEL}", "${sessionId}"))
db.commit()
print("DB title updated")
`);

  // 4. Inject the cached row with the OLD title + model
  const cache = JSON.parse(fs.readFileSync(CACHE, "utf-8"));
  const dbStartedAt = parseInt(py(`
import sqlite3
db = sqlite3.connect(r"${STATE_DB.replace(/\\/g, "\\\\")}")
print(db.execute("SELECT started_at FROM sessions WHERE id = ?", ("${sessionId}",)).fetchone()[0])
`), 10);
  // Set lastSync below this row's startedAt so it falls in the Phase-1 window
  cache.lastSync = dbStartedAt - 100;
  // Remove any existing entry for this id, then prepend our test entry
  cache.sessions = cache.sessions.filter((s) => s.id !== sessionId);
  cache.sessions.unshift({
    id: sessionId,
    title: OLD_TITLE,
    model: OLD_MODEL,
    startedAt: dbStartedAt,
    source: "desktop",
    messageCount: 0,
  });
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
  console.log("[setup] injected cache entry with old title + model");
  console.log("[setup] dbStartedAt:", dbStartedAt, "lastSync (after):", cache.lastSync);

  // 5. Attach + trigger sync
  const { browser, page } = await attach();
  // Force a sessions list reload — the renderer calls this on Sessions tab open.
  // The actual sync IPC is `sync-sessions` (returns the updated cache).
  await page.evaluate(async () => {
    return await window.hermesAPI.syncSessionCache();
  });
  // Give it a moment to write the file
  await new Promise((r) => setTimeout(r, 800));
  await browser.close();

  // 6. Read sessions.json and check
  const after = JSON.parse(fs.readFileSync(CACHE, "utf-8"));
  const cached = after.sessions.find((s) => s.id === sessionId);
  console.log();
  console.log("[result] cached entry after sync:");
  console.log("           title:", JSON.stringify(cached?.title));
  console.log("           model:", JSON.stringify(cached?.model));
  console.log("           expected title:", NEW_TITLE);
  console.log("           expected model:", NEW_MODEL);

  const titleOk = cached?.title === NEW_TITLE;
  const modelOk = cached?.model === NEW_MODEL;
  console.log();
  console.log(`[VERDICT title] ${titleOk ? "✅" : "🔴"} ${titleOk ? "title synced from DB" : "title NOT synced — bug present"}`);
  console.log(`[VERDICT model] ${modelOk ? "✅" : "🔴"} ${modelOk ? "model synced from DB" : "model NOT synced — bug present"}`);

  // 7. Restore
  fs.copyFileSync(STATE_BAK, STATE_DB);
  fs.copyFileSync(CACHE_BAK, CACHE);
  fs.unlinkSync(STATE_BAK);
  fs.unlinkSync(CACHE_BAK);
  console.log("[teardown] state.db + sessions.json restored");
})().catch((e) => {
  try {
    if (fs.existsSync(STATE_BAK)) { fs.copyFileSync(STATE_BAK, STATE_DB); fs.unlinkSync(STATE_BAK); }
    if (fs.existsSync(CACHE_BAK)) { fs.copyFileSync(CACHE_BAK, CACHE); fs.unlinkSync(CACHE_BAK); }
  } catch {}
  console.error("FAILED:", e.stack || e.message || e);
  process.exit(1);
});
