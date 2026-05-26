# Dev scripts — CDP-based E2E harness

This directory hosts dev-only one-shot scripts that drive the running
dev Electron over the Chrome DevTools Protocol. Use it to reproduce
bugs, verify fixes, or probe runtime state — much faster and more
deterministic than screenshot-driven testing.

The harness is **opt-in**: nothing about it touches production builds
or normal `npm run dev` workflows.

---

## Running a specific repro script (from a GitHub issue comment)

If you landed here from an issue comment that linked to `scripts/repro-<name>.js`,
this section walks you through running it from a clean checkout.

### Prerequisites

- Node.js 20+ (`node --version` to check)
- Git
- A working `hermes-agent` install on your machine (the same one Hermes
  Desktop uses — if Hermes Desktop runs for you, you have it)
- Two terminals open side-by-side

### One-time setup

```bash
# 1. Clone the branch that contains the repro scripts:
git clone -b test/369-382-383-stack https://github.com/pmos69/hermes-desktop.git
cd hermes-desktop

# 2. Install dev deps (takes 1–3 min on first run):
npm install
```

### Each time you run a repro

```bash
# Terminal 1 — start the dev electron with the CDP debug port enabled.
# This builds + launches the desktop app. Wait ~15 seconds until you
# see the Hermes Agent window appear. It will use your real
# ~/.hermes/ profile, so any chats you already have are visible.
ENABLE_CDP=1 npm run dev
```

```bash
# Terminal 2 — run the script. The verdict line at the bottom of the
# output tells you whether the bug reproduces on your machine.
node scripts/repro-<name>.js
```

### What the output looks like

Every repro script ends with a single `[VERDICT]` line:

- `[VERDICT] 🔴 REPRODUCED — …` → you're hitting the bug. Add a comment
  on the issue with your `[VERDICT]` line + your OS / model / version
  so the maintainer has evidence from multiple environments.
- `[VERDICT] ✅ …` → the bug doesn't trigger on your machine. Some bugs
  are host- or model-dependent (e.g. line-ending behaviour differs
  between macOS and Windows); a ✅ doesn't mean the bug isn't real,
  just that your environment happens to dodge it.
- `[VERDICT] ⚠️ …` → the script saw something unexpected. Paste the
  full output in the issue.

### Common issues

- **`Failed to connect to 127.0.0.1:9222`** — Terminal 1 isn't running,
  or you forgot the `ENABLE_CDP=1` prefix. Restart it.
- **`bind() returned an error`** in Terminal 1's log — port 9222 is
  already in use (often a zombie from a previous run). Use a different
  port: `ENABLE_CDP=1 CDP_PORT=9223 npm run dev`, then run the script
  with `CDP_PORT=9223 node scripts/repro-<name>.js`.
- **The script touches your real profile**. Most repros back up the
  files they mutate (`auth.json`, `config.yaml`, `sessions.json`) and
  restore on exit. Skim the script's header comment if you want to
  know exactly what it'll touch before running.

### Don't want to run the script?

A `+1 from <your OS / model>` comment on the issue is also useful
evidence. The script just gives a deterministic verdict; describing
your symptoms in plain English is equally valid input.

---

## Quickstart (for contributors writing new scripts)

1.  Start dev electron with CDP enabled:

    ```bash
    ENABLE_CDP=1 npm run dev
    ```

    (Or any other free port: `ENABLE_CDP=1 CDP_PORT=9223 npm run dev`.)

2.  In a separate shell, run a script:

    ```bash
    node scripts/e2e-attach.js
    ```

    The shared `attach()` helper connects Playwright to the running
    renderer over `http://127.0.0.1:9222` (or `$CDP_PORT`). You can
    drive the UI with DOM-aware selectors, evaluate IPC calls in the
    renderer, or read state from the running main process.

## How the opt-in works

`src/main/index.ts` reads `process.env.ENABLE_CDP` at startup and, when
set to `"1"`, appends `--remote-debugging-port=<CDP_PORT|9222>` to the
Chromium command line. Without the env var the switch is never added,
so production builds (and normal dev) never expose the port.

```ts
if (process.env.ENABLE_CDP === "1") {
  app.commandLine.appendSwitch(
    "remote-debugging-port",
    process.env.CDP_PORT || "9222",
  );
}
```

Three properties this gives us:

- **Off by default.** A user running the shipped app sees no CDP
  port. An attacker who sets the env var on a prod install still
  hits the existing Electron security model (sandbox,
  contextIsolation, preload allowlist) — they get whatever a regular
  user would.
- **Per-developer.** Whoever wants the harness flips one env var;
  everyone else has zero footprint.
- **Multi-window safe.** `CDP_PORT` lets you run multiple dev
  electron instances side-by-side (a clean profile + a real profile,
  for instance) without port collisions.

## Writing a repro script

The convention used by the existing scripts:

```js
// scripts/repro-my-bug.js
const { attach } = require("./e2e-attach");

(async () => {
  const { browser, page } = await attach();
  // …drive the app via page.click / page.fill / page.evaluate…
  // …observe DOM, IPC return values, on-disk state…
  const verdict = /* boolean check */;
  console.log(`[VERDICT] ${verdict ? "✅" : "🔴"} <what was tested>`);
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.stack || e.message || e);
  process.exit(1);
});
```

Naming conventions:

| Prefix | Purpose | Lives long? |
|---|---|---|
| `repro-<short-name>.js` | Reproduce a specific bug. Pair with an issue number or commit. Print `[VERDICT] 🔴 REPRODUCED` (pre-fix) or `[VERDICT] ✅ FIXED` (post-fix). | Until the fix is shipped + a regression test exists; then it can be deleted or kept as a manual reference. |
| `drive-<flow>.js` | Walk through a user flow end-to-end (e.g. OAuth sign-in, model switch + chat). | Keep alongside the feature so future contributors can re-run. |
| `probe-<aspect>.js` | Read-only inspection. No state mutation. Useful for understanding a bug before writing a repro. | Useful long-term as documentation. |
| `verify-<feature>.js` | Live verifier paired with a PR. Asserts `[VERDICT A/B/C/D]` lines for each contract the PR claims. | Lives with the PR; can be repurposed as a manual smoke test. |

## Things to remember

- **The harness is a Node CommonJS script**, not part of the TS build.
  Use `require()`. The project's ESLint config ignores
  `scripts/e2e-attach.js`, `scripts/repro-*.js`, `scripts/probe-*.js`,
  `scripts/drive-*.js`, and `scripts/verify-*.js` so the
  `no-require-imports` rule doesn't fire here.

- **`page.evaluate(async () => window.hermesAPI.foo())` is your friend.**
  The renderer's `hermesAPI` is exposed via contextBridge, so the
  harness can call any IPC the UI can. This is often more reliable
  than driving clicks, especially for tests of main-process state.

- **Don't close the dev electron from the script** —
  `browser.close()` detaches Playwright but leaves the app running.
  If you need the app gone, kill it separately.

- **Restart `npm run dev` after main-process changes.**
  electron-vite hot-reloads renderer files, but main-process changes
  don't always restart the bundled main binary. When in doubt, kill
  the electron processes and restart dev.

- **Port 9222 can get stuck in a zombie LISTEN state** on Windows
  after a force-kill. If `bind() returned an error` shows up in the
  dev log, switch to `CDP_PORT=9223` (or any other free port).

## A real example

The patterns above came out of triaging the v0.5.1 bug reports
("Session continuation requires API key authentication", session
proliferation, Edit Model dialog API-key bug, Nous Portal silent
misconfiguration). Each reproducible bug got a `repro-*.js` that
flipped from 🔴 pre-fix to ✅ post-fix in under a minute — vs the
multi-minute screenshot loop the same flow used to require.

If you write a useful repro, add it to this directory and link it
from the related PR / issue. The next contributor will thank you.
