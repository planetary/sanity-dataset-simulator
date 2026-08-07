# §0.6 human validation script — the actual Studio workflow

**Status:** Draft
**Date:** 2026-08-06
**Source:** [docs/PRD-v1.md](../../../PRD-v1.md) §0.6 execution rules
**Roadmap phase:** 1 of 9 — see the [delivery roadmap](../../README.md)
**Discharges:** PRD §0.6 — *"A spike passes only with automated tests plus one human validation of the actual Studio workflow."*

---

## 0. What this is and why it exists

Every gate in [gate-review.md](gate-review.md) is currently marked **"Human validation: OUTSTANDING"**. The two browser sessions recorded in [live-validation-2026-08-04.md](live-validation-2026-08-04.md) were driven by an agent through chrome-devtools MCP, and §0.6's rule is not satisfied by an agent run **by definition** — it asks for a human to use the editor.

The blocker has never been the owner's time. It has been that nobody wrote down what "it" is. This is "it".

**Who runs it:** a human, at a keyboard, using a mouse and a trackpad caret. Not an agent, not a script, not Playwright. Where a step *does* have a command, the command is an oracle you run in a terminal to check what the browser told you — never a substitute for doing the thing.

**How long:** about 60–75 minutes including setup, if nothing fails.

**The standing evidence rule** ([HANDOFF §1](../../HANDOFF.md), reaffirmed by [live-validation §1.3](live-validation-2026-08-04.md)): **server-side logs and files on disk are the only trustworthy escape evidence.** Browser-side observation has produced false all-clears three times on this project. Every step below therefore has a browser observation *and*, wherever one exists, a disk-or-log oracle. Where a step has only a browser observation, it says so.

### What a failing step means

Record it and stop that section. Per §0.6: a repair attempt must target the **observed** failure and must not broaden scope; each strategy gets at most two focused attempts before an architecture review. Copy the failure verbatim into §12 of this document and into [gate-review.md](gate-review.md)'s risk list before any code moves.

### What this script cannot discharge

Named here so a signed run is not read as more than it is.

| Not covered | Why | Tracked at |
|---|---|---|
| Gates C and F | Blob concurrency and lifecycle. Need a Vercel project and a private Blob token. Nothing is built. | [gate-review](gate-review.md) rows C, F |
| The deployed half of Gate E | No preview deployment exists, so there is no enforcement layer to validate. The proxy is a local process. | [gate-review](gate-review.md) row E |
| Branch asset upload | `client.assets.upload` is refused outright by the facade. Adding an image to a branch does not work yet — [PRD §0.0](../../../PRD-v1.md) records this as a known gap, not a resolved item. | PRD §0.0 |
| Installing the package | No package in `packages/` is installable: 106 relative import specifiers escape their own package root (measured 2026-08-06 over `packages/*/src`, testkit excluded; the count moves as work lands). The Studio under test imports the plugin by relative path from inside this monorepo. | [phase-3 acceptance audit F-1](../phase-3/acceptance-audit.md) |
| The browser E2E suite | `e2e/` exists and is untracked; `@playwright/test` is not installed and `playwright.config.ts` cannot even be imported. | `e2e/README.md` |
| The overlay conflict panel | See **H21** — the panel is built and tested at the unit layer but is unreachable in a browser today, for a reason in the code. | This document, §8 |

---

## 1. Setup

### 1.1 Preconditions

- Node 22 (`node --version` → `v22.x`). The CLI and the launchers rely on native TypeScript type-stripping.
- `pnpm` 10.33.2 (`packageManager` in the root `package.json`).
- A Sanity account with read access to project `b1n03q3z`, dataset `parity`. Run `pnpm --filter kitchen-sink exec sanity login` if you have never signed in on this machine.
- A clean `git status` for `examples/` and `docs/`, or at least a note of what was already dirty. You are about to compare files.

### 1.2 A scratch overlay root — do not skip this

`examples/kitchen-sink/.sanity-overlay/` is **committed evidence** from the 2026-08-04 and 2026-08-05 sessions (7 tracked files; `.gitignore` deliberately does *not* ignore it). Editing through the default root would rewrite that evidence.

```bash
cd /path/to/sanity-dataset-simulator
export VALIDATION_ROOT="$PWD/.validation-$(date +%Y%m%d-%H%M)"
mkdir -p "$VALIDATION_ROOT"
echo "$VALIDATION_ROOT"
```

Keep that terminal, or re-export `VALIDATION_ROOT` in every terminal below. Add the directory to your local excludes so it never lands in a commit:

```bash
echo "/.validation-*" >> .git/info/exclude
```

### 1.3 Point the Studio at the proxy

The Studio's overlay settings are read from `examples/kitchen-sink/.env` (the Studio-idiomatic declared source — `sanity.cli.ts` reads that file in Node before Vite starts). Create it if it does not exist:

```bash
cat >> examples/kitchen-sink/.env <<'EOF'
SANITY_STUDIO_OVERLAY_MODE=fs
SANITY_STUDIO_OVERLAY_API_URL=http://localhost:3998
SANITY_STUDIO_OVERLAY_API_HOST=http://localhost:3999
EOF
```

- `OVERLAY_MODE` — the plugin defaults to `fs` with a warning if absent (`packages/sanity-overlay-studio/src/options.ts`, "THE DEFAULT MODE IS THE SAFETY DECISION"). Setting it explicitly removes the warning and makes the run reproducible.
- `OVERLAY_API_URL` — where writes go. Default is already `http://localhost:3998`.
- `OVERLAY_API_HOST` — routes the Studio's Sanity traffic through the Track B proxy. **Without it the Studio talks to Sanity directly and the proxy sees nothing**, which silently removes the only server-side boundary in the run. H2 checks this took effect.

`.env` is gitignored, so this does not dirty the tree.

### 1.4 Boot the stack — four terminals

Each block is one terminal, in this order. Wait for each to report ready before starting the next.

```bash
# ── terminal 1 ── Track B proxy, default-deny write guard          → :3999
cd /path/to/sanity-dataset-simulator
PROXY_BLOCK_WRITES=1 \
PROXY_LOG="$VALIDATION_ROOT/proxy-log.jsonl" \
  node examples/kitchen-sink/spikeB-proxy/proxy.mjs
```

> `PROXY_LOG` is **not optional**. The default is `./proxy-log.jsonl`, which is pinned evidence at exactly 730 lines and has been contaminated twice by someone starting the proxy without it.

```bash
# ── terminal 2 ── overlay persistence server                        → :3998
cd /path/to/sanity-dataset-simulator
node examples/kitchen-sink/overlayApiServer.mjs \
  --root="$VALIDATION_ROOT" \
  --port=3998 \
  --origin=http://localhost:3333 \
  --id=human-validation
```

```bash
# ── terminal 3 ── the Studio                                        → :3333
cd /path/to/sanity-dataset-simulator
pnpm --filter kitchen-sink dev
```

```bash
# ── terminal 4 ── your oracle shell; run every check below here
cd /path/to/sanity-dataset-simulator
export VALIDATION_ROOT=<the path printed in 1.2>
export OVERLAY_JSON="$VALIDATION_ROOT/.sanity-overlay/documents/article-01/intent.json"
```

Port 3333 is not negotiable: the overlay API grants CORS to exactly one origin.

### 1.5 Which code path is under test

`examples/kitchen-sink/sanity.config.ts` contains two paths and picks by `localStorage`. **This script validates the product path** — `defineOverlayConfig` from `packages/sanity-overlay-studio`. Before you begin, in the Studio's browser console:

```js
['SPIKE_LOCAL_ECHO','SPIKE_API_HOST','SPIKE_INSTRUMENT','SPIKE_OVERLAY_PERSIST','SPIKE_STRICT_QUERIES']
  .forEach(k => localStorage.removeItem(k))
location.reload()
```

Any one of those flags being non-blank silently switches the whole Studio onto the Spike A rig. If you find yourself validating `window.__SPIKE_ECHO__`, you are on the wrong path — clear the flags and reload.

---

## 2. Boot and identity — H1 to H3

### H1 — The Studio boots on the overlay, not on staging

**Do:** open `http://localhost:3333`. Sign in if prompted.

**Observe:** a banner across the top of the Studio, dark grey, titled **BRANCH OVERLAY**, with the headline:

> Branch overlay active. Edits stay local and never reach the shared dataset.

and detail lines including `Storage: filesystem (.sanity-overlay)` and `Overlay: human-validation`.

**FAIL if:**
- there is no banner at all (the layout was not installed — `sanity.config.ts` did not pass `layout`);
- the headline is *"Overlay off — this Studio is editing the native Sanity dataset."* (mode resolved to `off`);
- the headline is *"Overlay identity mismatch…"* on a red banner and the Studio is unusable (the `--id` in terminal 2 disagrees with what the plugin derived — stop, do not edit anything).

**Oracle:** none. Browser-only. The banner is a rendering of state, not evidence of it — H4 is the first step that proves anything.

---

### H2 — The Studio's Sanity traffic actually goes through the proxy

**Do:** nothing extra. The Studio has already loaded documents.

**Observe (terminal 4):**

```bash
wc -l "$VALIDATION_ROOT/proxy-log.jsonl"
grep -c '/data/query/' "$VALIDATION_ROOT/proxy-log.jsonl"
```

**Expect:** a non-zero line count, and at least one `/data/query/` row.

**FAIL if the log is empty or absent.** That means `SANITY_STUDIO_OVERLAY_API_HOST` did not reach the browser bundle — Vite inlines `SANITY_STUDIO_*` from `examples/kitchen-sink/.env` and from the shell, so check the file, restart terminal 3, and reload. **Do not continue with an empty proxy log**: every "staging untouched" claim below rests on this being the only route out.

---

### H3 — Hosted features are gone from the chrome

**Do:** look at the left tool bar and open any document's inspector menu (the icon row at the top-right of a document pane).

**Observe:** no **Vision**, no **Releases**, no **Schedules**, no **Media Library**, no **Canvas** tool. No **Comments** inspector. No **History** inspector on a document.

**FAIL if any of those five tools or two inspectors is present** — `filterHostedTools` / `filterHostedInspectors` did not compose (`packages/sanity-overlay-studio/src/features.ts`).

**Known and expected, not a failure:** paste a `?rev=` or `?since=` parameter onto a document URL and the native timeline machinery still answers. Native History is removed at the **inspector name** only; `sanity@6.8.0` has no on/off key for it, and the underlying document-events machinery, the pane params and the "compare versions" route all remain reachable by deep link. This is recorded as `removal: 'partial'` in `features.ts` and is the honest state of the world, not a defect to file. See the [plugin compatibility guide](../../../plugin-compatibility.md).

---

## 3. The edit that mattered — H4 to H6

This section exists because a silent data-loss bug lived here and 2048 green tests could not see it ([live-validation §1.1](live-validation-2026-08-04.md)): diff-match-patch headers count **UTF-8 bytes**, the parser counted **JavaScript characters**, the editor showed a successful save, and the overlay stayed empty.

### H4 — A non-ASCII scalar edit reaches disk with its bytes intact

**Do:** open the document **Article 1** (`article-01`). Click into the **Title** field, select all, and **type** — do not paste — exactly:

```
Article 1 — OVERLAY EDIT ✅ 日本語
```

That string is chosen to cover three separate failure classes in one edit: `—` is U+2014 (3 UTF-8 bytes, 1 JS character), `✅` is U+2705 in the astral-adjacent range that dmp charges asymmetrically, and `日本語` is CJK. Use your OS input method or copy the line above into the field character by character if your keyboard cannot produce them; typing is preferred because it exercises the debounce.

Wait for the Studio's save indicator to settle (about 2 seconds after your last keystroke).

**Observe:** the field renders the full string; no error toast; the banner is still the neutral *"Branch overlay active"* headline and not *"…is unreachable"*.

**Oracle (terminal 4) — this is the load-bearing check:**

```bash
node --input-type=module -e '
import {readFileSync, existsSync} from "node:fs"
const p = process.env.OVERLAY_JSON
const want = "Article 1 — OVERLAY EDIT ✅ 日本語"
if (!existsSync(p)) { console.log("FAIL: no intent.json at", p); process.exit(1) }
const text = readFileSync(p, "utf8")
const doc = JSON.parse(text)
const override = (doc.draft?.overrides ?? []).find(o => JSON.stringify(o.path) === JSON.stringify(["title"]))
console.log("file          :", p)
console.log("codepoints    :", [...want].length, " utf8 bytes:", Buffer.byteLength(want, "utf8"))
console.log("raw bytes hit :", text.includes(want) ? "PASS" : "FAIL")
console.log("override value:", JSON.stringify(override?.value))
console.log("exact match   :", override?.value === want ? "PASS" : "FAIL")
console.log("touchedPaths  :", JSON.stringify(doc.touchedPaths))
'
```

**Expect:** `raw bytes hit: PASS`, `exact match: PASS`, `touchedPaths: [["title"]]`, and the codepoint count (30) different from the UTF-8 byte count (38) — that difference is the whole point of the test.

**FAIL if:**
- there is **no `intent.json`** — the edit was echoed to the editor and never persisted. This is the exact 2026-08-04 defect shape: the editor shows success while the overlay stays at `revision 0, documents: []`. Check terminal 2 for a `Hunk declares length2 N but its context and insertions total M characters` line.
- `exact match: FAIL` with a value that is a **prefix or a mangled tail** of what you typed — byte/character miscounting, the same class.
- `exact match: FAIL` with the pre-edit value `"Article 1"` — the write never landed.
- `touchedPaths` is empty or names a path you did not edit.

**Record the exact `override value` string in §12, whatever it is.**

---

### H5 — The edit survives a reload

**Do:** hard-reload the Studio (⌘⇧R / Ctrl-Shift-R). Reopen Article 1.

**Observe:** the Title field renders the full string from H4, including `✅` and `日本語`.

**Oracle:** re-run H4's command. The file must be unchanged.

**FAIL if** the field shows the base title `Article 1` after reload — the overlay is not being applied on read, only echoed on write.

---

### H6 — The edit survives an overlay server restart

**Do:** Ctrl-C terminal 2. Restart it with the identical command. Hard-reload the Studio.

**Observe:** the Title field still renders the full string.

**FAIL if** the value is lost — persistence is in memory, not on disk, whatever `intent.json` said.

---

## 4. Cursor, selection and keystrokes under a real debounce — H7 to H10

This is the half of PRD §21.4.1 criterion 2 that **only a human can measure**. [gate-review](gate-review.md) row B says so explicitly: the protocol half is automated; the input-device half "is a DOM property and remains browser-only", and scripted `input` events do not exercise it. It is also a §0.6 abort trigger in its own right — *"lost keystrokes, cursor jumps, stuck save indicators, duplicate patches, or stale panes"*.

Work on the **Title** field of Article 1 throughout. Do not touch the mouse during a step unless told to.

### H7 — The caret does not jump when a save lands

**Do:**
1. Set the Title to exactly `ABCDEFGHIJ` and wait 3 seconds for the save to settle.
2. Click once to place the caret **between `E` and `F`** (position 5). Do not select anything.
3. Type `XYZ` at a normal speed. Do not touch anything else.
4. Count to five out loud. Do not click, do not tab away.
5. Type `123`.

**Observe:** the final value is exactly

```
ABCDEXYZ123FGHIJ
```

and the caret is sitting immediately after `3`.

**FAIL if:**
- the value is `ABCDEXYZFGHIJ123` — the caret jumped to the end when the save landed between step 3 and step 5. **This is a §0.6 abort trigger** ("cursor jumps").
- the value is `ABCDEXYFGHIJ` or any other string missing one of your characters — **lost keystroke**, also a §0.6 abort trigger.
- the value contains a duplicated run such as `XYZXYZ` — duplicate patch application.

**Oracle:**

```bash
node -e 'const d=JSON.parse(require("fs").readFileSync(process.env.OVERLAY_JSON,"utf8"));
console.log(JSON.stringify((d.draft?.overrides??[]).find(o=>o.path[0]==="title")?.value))'
```

The disk value must equal the field value **exactly**. A field that reads correctly while disk holds `ABCDEXYZFGHIJ` is worse than a visible jump: the editor and the overlay have diverged with no signal.

---

### H8 — A selection is not destroyed by a save

**Do:**
1. Reset the Title to `ABCDEFGHIJ`, wait 3 seconds.
2. Click before `C` and shift-click after `G` so `CDEFG` is selected (five characters, highlighted).
3. Count to five. Do not move the mouse or press a key.
4. Type `Q`.

**Observe:** the value becomes `ABQHIJ` — the selection was still live and the typed character replaced it.

**FAIL if** the value becomes `ABCDEFGHIJQ` or `QABCDEFGHIJ` — the selection was collapsed by a re-render during the debounce window.

---

### H9 — Fast typing is not throttled into loss

**Do:** clear the Title. Type the following as fast as you comfortably can, in one burst, without pausing:

```
the quick brown fox jumps over the lazy dog 0123456789
```

Wait 3 seconds.

**Observe:** the field shows all 54 characters.

**Oracle:**

```bash
node -e 'const d=JSON.parse(require("fs").readFileSync(process.env.OVERLAY_JSON,"utf8"));
const v=(d.draft?.overrides??[]).find(o=>o.path[0]==="title")?.value ?? "";
console.log(JSON.stringify(v)); console.log("length:", v.length, v.length===54?"PASS":"FAIL")'
```

**FAIL if** length is not 54 in the field or on disk.

---

### H10 — The save indicator settles

**Do:** watch the Studio's own document-pane save state (the "Saved"/"Saving" affordance next to the document title) and the overlay banner, immediately after H9's burst.

**Observe:** within a few seconds the Studio reports saved and the overlay banner headline returns to *"Branch overlay active…"*.

**FAIL if** the Studio sits on "Saving" indefinitely, or the banner is stuck on *"Saving N change(s) to the overlay…"*. A stuck save indicator is a §0.6 abort trigger.

> **Note for the recorder, not a failure:** in the shipped runtime the banner's `saving` state is currently **unreachable** — `runtime.ts` initialises `pendingWrites` to `0` and only ever decrements it, so the banner never enters `saving`. If you *do* see the saving headline, something has changed in `runtime.ts` since 2026-08-06 and this note is stale; if you never see it, that is expected and the Studio's own indicator is the one that matters here.

---

## 5. Portable Text under a real debounce — H11 to H14

Portable Text is the field type most likely to lose state to a re-render, because its value is an array of keyed blocks and a naive re-key destroys the editor's selection anchor. None of this is covered by the Node suite.

Use the **Body** field of Article 1.

### H11 — Type a paragraph and check the block key is stable

**Do:** click into Body, type `First paragraph.` and wait 3 seconds.

**Oracle:**

```bash
node -e '
const d=JSON.parse(require("fs").readFileSync(process.env.OVERLAY_JSON,"utf8"));
const body=(d.draft?.overrides??[]).find(o=>o.path[0]==="body");
console.log(JSON.stringify(body?.value, null, 2))' | head -40
```

**Expect:** an array with one block carrying a `_key` and one child span. **Write that `_key` down.**

### H12 — Add a second block; the first block's key does not move

**Do:** press Enter, type `Second paragraph.`, wait 3 seconds.

**Oracle:** re-run H11's command.

**Expect:** two blocks. The first block's `_key` is **the same value you wrote down**.

**FAIL if the first block's `_key` changed.** A re-keyed block is how a Portable Text editor loses your caret, and it will show up as a cursor jump the next time you edit mid-document.

### H13 — Edit in the middle of the first block while the second exists

**Do:** click between `First` and ` paragraph` in block one. Type `ish`. Count to five. Type `!`.

**Observe:** block one reads `Firstish! paragraph.` — contiguous, at the insertion point.

**FAIL if** the `!` lands at the end of the block, at the end of the document, or in block two.

### H14 — Apply a mark across a save boundary

**Do:** select the word `Second` in block two. Wait three seconds *with the selection held*. Then press ⌘B / Ctrl-B.

**Observe:** exactly `Second` is bold. Nothing else changed.

**FAIL if** the bold applies to the wrong range, to the whole block, or not at all — the selection did not survive the debounce.

**Oracle:** re-run H11's command and confirm the marks array on the affected span.

---

## 6. Document actions visibly settling — H15 to H19

`write-block-validation.md` recorded the publish button going dead (`handled: false`) in an earlier session. The fix has Node-level evidence only ([phase-3 acceptance audit](../phase-3/acceptance-audit.md), line 4: *"the browser half has no test that could fail because it has no test"*). This section is that test.

For each action: click it, then **watch the button**. "Settling" means the action's spinner/disabled state resolves and the pane returns to an interactive state without a reload.

### H15 — Publish

**Do:** on Article 1, click **Publish**.

**Observe:** the button shows progress and then settles; the document pane shows a published state; no error toast; the banner does not go red.

**Oracle:**

```bash
node -e '
const d=JSON.parse(require("fs").readFileSync(process.env.OVERLAY_JSON,"utf8"));
console.log("has published block:", d.published !== undefined);
console.log("tombstones:", JSON.stringify(d.tombstones))'
```

**Expect:** `has published block: true`.

**FAIL if** the button never settles, or `published` is absent from `intent.json` after the button reported success.

### H16 — Unpublish

**Do:** open the document's action menu (the chevron next to Publish) and click **Unpublish**.

**Observe:** settles; the document returns to a draft-only state.

**Oracle:** re-run H15's command. `tombstones.published` must now be `true`.

### H17 — Discard changes

**Do:** make a small title edit, wait for the save, then action menu → **Discard changes**.

**Observe:** settles; the field reverts.

**Oracle:** the title override for `article-01` is gone from `intent.json`, or the whole `draft` block is.

### H18 — Duplicate

**Do:** action menu → **Duplicate**.

**Observe:** settles; a new draft document opens.

**Oracle:**

```bash
ls "$VALIDATION_ROOT/.sanity-overlay/documents/"
```

**Expect:** a second directory alongside `article-01`. Note its name in §12.

### H19 — Delete uses a tombstone, not a hole

**Do:** on the duplicate you just made, action menu → **Delete**. Confirm Studio's own delete confirmation.

**Observe:** settles; the document disappears from the list pane.

**Oracle:**

```bash
node -e '
const fs=require("fs"); const dir=process.env.VALIDATION_ROOT+"/.sanity-overlay/documents";
for (const id of fs.readdirSync(dir)) {
  const d=JSON.parse(fs.readFileSync(dir+"/"+id+"/intent.json","utf8"));
  console.log(id, JSON.stringify(d.tombstones));
}'
```

**Expect:** the deleted document's directory **still exists** with `{"draft":true,"published":true}` (or equivalent). A tombstone suppresses the base row; it does not remove the record.

**FAIL if** the directory vanished — a delete that removes the record cannot suppress a base document that still exists upstream, and the document will reappear on the next read.

---

## 7. The confirm dialog actually blocks — H20

`packages/sanity-overlay-studio/src/documentActions.ts` states the invariant: *"DESTRUCTION IS CONFIRMED, ALWAYS. `onHandle()` never sends. It opens the confirm dialog whose message IS the loss report, and only `dialog.onConfirm()` reaches the transport."* Two of the three overlay actions return `dialog: {type: 'confirm'}`. **Cancel must be a true no-op on disk.** That is the falsifiable form.

### H20 — Cancel changes nothing; Confirm changes something

**Do:**

1. Take a fingerprint of the whole overlay tree (terminal 4):

   ```bash
   find "$VALIDATION_ROOT/.sanity-overlay" -type f | sort | xargs shasum -a 256 | shasum -a 256
   ```

   Write the hash down.

2. In the Studio, on Article 1, open the action menu and click **Create checkpoint**.

3. **Observe:** a confirmation dialog appears whose message names the count, e.g. *"Create a checkpoint of all N overlay documents? A checkpoint only writes files — no branch state is changed and nothing is lost."*

4. Click **Cancel**.

5. Re-run the fingerprint command.

**Expect:** the hash is **byte-identical**.

**FAIL if the hash changed after Cancel** — `onHandle` sent, which means the confirmation is decoration. That is the whole defect class this step exists for.

6. Repeat steps 2–3 and click **Confirm** this time. Re-run the fingerprint.

**Expect:** the hash **changed**, and the action button settles.

**FAIL if the hash is unchanged after Confirm** — the dialog is inert in the other direction, which is just as bad and much easier to miss.

7. Repeat the whole of H20 for **Rebase onto current base**, whose confirm dialog carries a *loss report* and, when the rebase is destructive, `tone: 'critical'`.

**Expected variant, not a failure:** if the menu shows *Rebase onto current base* **disabled** with a tooltip explaining there is nothing to rebase, record that and move on — `rebaseDescription` returns `{disabled: true, dialog: false}` when the plan is empty.

> **Note:** *Resolve conflicts* is the third overlay action and deliberately does **not** use a confirm dialog — it opens a custom panel whose confirmation is a per-action checkbox. See H21.

---

## 8. The conflict panel — H21

### H21 — Confirm the panel is unreachable, and that the Studio says so

This step's expected result is a **negative**, and it is worth recording precisely because the Studio contains a fully built conflict panel that a reader of the code would assume is live.

**Why it is unreachable today.** The Studio's conflict report is read from the overlay API's `GET /state` response (`runtime.ts` → `readConflictReport`). Neither overlay server returns a `conflicts` field or a `conflictSummary` from `/state`: `packages/sanity-overlay-next/src/api.ts` returns `{ok, overlayId, revision, documents}`, and `examples/kitchen-sink/spikeA/overlayServer.mjs` does the same. Conflicts *are* computed — but only inside `POST /resolve`, per read, from base documents the caller supplies. So `readConflictReport` takes its `!sawConflictField` branch every time.

**Do:** open Article 1's document action menu.

**Observe:** an item reading **Conflict state unknown**, greyed out and not clickable, whose tooltip is:

> This overlay API does not report conflicts, so this document's conflict state is unknown — which is not the same as clean.

**Also observe:** the banner's `Conflicts` detail line, and whether it claims `0 soft, 0 hard`.

**FAIL if:**
- there is **no** conflict menu item at all — `documentConflictIndicator` returned `state: 'none'`, meaning something reported an authoritative "clean" that the API is not in a position to know. That is the dangerous direction.
- the item is **enabled** and opens the panel — then this note is stale, the API now reports conflicts, and you should validate the panel properly: the four §28.3 value rows (`Ancestor`, `Current staging`, `Branch value`, `Resolved preview value`), the per-action loss checkbox (`I accept this loss — …`), and that an action button stays disabled until the checkbox is ticked.

**Record which of the three you saw.** This is a finding either way.

**Not attempted here:** inducing a real conflict requires the base to move under the branch — a human editing the same field of `article-01` in the hosted Sanity Studio at `sanity.io/manage`, which is legal under [PRD §0.0](../../../PRD-v1.md) (the ruling forbids *this system* writing; it does not forbid a person editing staging) but requires write access to `parity` and is out of scope for a first human validation.

---

## 9. Authentication, refusal and logout — H22 to H24

### H22 — A write-guard 403 does not log the editor out

This is a live regression, dated in the code: `packages/sanity-overlay-studio/src/client/echo.ts` records *"Observed live, 2026-08-06: Studio said 'Your Sanity session is no longer authenticated. Editing is read-only' while the session was fine. The only 4xx responses in that session were the Track B write guard refusing…"*.

**Do:** in the browser console, provoke a blocked write straight at the proxy:

```js
await fetch('http://localhost:3999/v2025-02-19/data/mutate/parity', {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({mutations: [{patch: {id: 'article-01', set: {title: 'nope'}}}]}),
}).then(r => r.status)
```

**Expect:** `403`.

**Observe in the Studio, immediately after:** the banner headline is **still** *"Branch overlay active…"*. It must **not** become *"Your Sanity session is no longer authenticated. Editing is read-only until the token refreshes."*

**Then:** make a normal title edit and confirm it still reaches disk (re-run H4's oracle).

**Oracle:**

```bash
grep '"blocked":true' "$VALIDATION_ROOT/proxy-log.jsonl" | tail -1
```

**Expect:** a row with `"status":403` and the body code `OVERLAY_WRITE_BLOCKED`.

**FAIL if** the banner flips to unauthenticated, or writes stop being acknowledged. The transport only ends a session when the overlay body declares `origin: 'sanity' | 'content-lake' | 'upstream'`; a guard refusal is not that.

### H23 — Signing out makes the Studio read-only rather than silently lossy

**Do:** use Studio's own **Sign out** (avatar menu, top right).

**Observe:** the overlay banner turns critical and reads:

> Signed out. The overlay will not acknowledge writes; reload after signing in.

**Then:** try to type in a field.

**Expect:** editing is refused or not acknowledged; **nothing new appears on disk**.

**Oracle:** re-run the H20 fingerprint before and after your typing attempt. It must not change.

**FAIL if** an edit made while signed out reports "saved" and lands on disk — a write accepted without a session is exactly the class of bug that produced [HANDOFF §3](../../HANDOFF.md) item 6 ("a write rejected after a 401 still reached disk before being reported failed").

### H24 — Signing back in restores writes only after a reload

**Do:** sign back in. Without reloading, try to edit.

**Observe:** the logged-out state is **terminal** by design (`echo.ts`: *"`logged-out` — terminal. A new session arrives with a new page load."*). Expect writes still to be refused.

**Then:** hard-reload. Edit. Confirm the edit reaches disk.

**FAIL if** a reload does not restore writes.

> **Cannot be validated in a browser today — record as a gap, do not attempt.** The *token-refresh* path (`echo.restoreSession()` on a live `GET /users/me` identity, after `noteAuthFailure`) is unreachable from either overlay server, because neither one ever sets `origin: 'sanity'` on an error body, and only that declaration calls `onAuthFailure`. There is no browser route into the `unauthenticated` state that this path exits from. Validating it needs a fault-injecting overlay server that does not exist.

---

## 10. Reconnect through the real listener transport — H25 to H26

`@sanity/client@7.26.0` streams `/data/listen/<dataset>` as SSE **over `fetch`, not `EventSource`** — a Spike A finding in its own right (`examples/kitchen-sink/spikeA/eventSourceTap.ts`), and the reason a Track B proxy must stream response bodies rather than proxy `EventSource`. This section exercises the real one.

> **For the record, and not what this section tests:** the overlay API serves its own SSE bridge at `GET /events`, but **no shipping client subscribes to it** — the Studio package contains no `EventSource` and no reconnect logic at all. `ui/statusLayout.ts` polls `GET /state` on a fixed `setInterval` of 5000 ms with no backoff and no give-up. Only tests consume `/events`.

### H25 — A listener drop recovers, and edits made after it still land

**Do:**

1. With the Studio open on Article 1, note the current proxy-log line count.
2. Ctrl-C **terminal 1** (the proxy). Count to ten.
3. Restart terminal 1 with the identical command (same `PROXY_LOG` path — the proxy appends).
4. Return to the Studio. Do **not** reload.

**Observe:**
- during the outage, form fields may briefly go read-only. That is Studio's own behaviour on a reconnect gap (`WorkspaceLoader-BRx2afZV.js:10970`, recorded in [live-validation §1.2](live-validation-2026-08-04.md)) and is expected;
- after the restart, the Studio recovers **without** a manual reload.

5. Edit the Title. Wait 3 seconds.

**Oracle:**

```bash
grep -c '/data/listen/parity' "$VALIDATION_ROOT/proxy-log.jsonl"
node -e 'const d=JSON.parse(require("fs").readFileSync(process.env.OVERLAY_JSON,"utf8"));
console.log(JSON.stringify((d.draft?.overrides??[]).find(o=>o.path[0]==="title")?.value))'
```

**Expect:** the listen count is higher than before the outage (the client re-subscribed), and the post-outage edit is on disk.

**FAIL if:**
- the Studio never recovers and needs a reload;
- fields stay permanently read-only;
- the post-outage edit does not reach disk.

### H26 — The HTTP/1.1 concurrency ceiling, probed deliberately

This is [gate-review](gate-review.md) **recorded risk 1**, deliberately unpatched, and the decision to accept or fix it is an owner decision that this run is meant to inform. The boundary is exact and reproduced in `packages/sanity-overlay-testkit/test/proxy-concurrency.test.ts`: with a pool of 6, **five concurrent listener streams complete and six never do**. Chrome's HTTP/1.1 per-host limit is 6; the proxy speaks plain HTTP/1.1; real Sanity avoids this with HTTP/2 multiplexing.

**Do:** open documents in split panes until you have **six or more document panes open at once** on the same Studio tab (in the structure tool, keep clicking through to child documents rather than replacing the pane). Then click into the structure tool's root list.

**Observe:** whether the structure tool renders, hangs, or crashes with a socket timeout.

**Oracle:**

```bash
awk -F'"path":"' '/data\/listen\/parity/{print}' "$VALIDATION_ROOT/proxy-log.jsonl" | wc -l
grep -c 'OPTIONS' "$VALIDATION_ROOT/proxy-log.jsonl"
```

The live signature of the defect is **preflights without a matching completed GET** — rows are written on completion, so a hung request has no row at all. In the 2026-08-04 session `/data/listen/parity` showed **72 preflights against 34 completed GETs**.

**Record the outcome either way.** A clean run does not disprove the ceiling — it is load-dependent and Session B did not crash either. What is being recorded here is whether it is hit in ordinary interactive use, which is the input the accept-or-fix decision needs.

---

## 11. Staging is untouched — H27 to H28

The closing oracle. This is the claim the whole product rests on, and it is checked **against Sanity's own API**, not against anything this system wrote.

### H27 — No branch content reached the dataset

**Do (terminal 4):** with the read token from the repo-root `.env`:

```bash
set -a; . ./.env; set +a
API="https://$SANITY_PROJECT_ID.api.sanity.io/v$SANITY_API_VERSION/data/query/$SANITY_BASE_DATASET"

curl -s -H "Authorization: Bearer $SANITY_API_READ_TOKEN" \
  --get "$API" --data-urlencode 'query=*[_id=="article-01"][0]{_id,_rev,title}' | tee /tmp/hv-published.json

curl -s -H "Authorization: Bearer $SANITY_API_READ_TOKEN" \
  --get "$API" --data-urlencode 'query=*[_id=="drafts.article-01"][0]{_id,_rev,title}' | tee /tmp/hv-draft.json
```

**Expect:**
- the published document's `title` is the **base** title (`Article 1`), **not** anything you typed;
- the second query returns `{"result":null,...}` — **no `drafts.article-01` exists at all**.

**FAIL on either.** A `drafts.article-01` appearing upstream means a write escaped, and the run must stop and be reported immediately.

### H28 — The base revision the overlay recorded still matches staging

**Do:**

```bash
node -e '
const fs=require("fs");
const local=JSON.parse(fs.readFileSync(process.env.OVERLAY_JSON,"utf8"));
const remote=JSON.parse(fs.readFileSync("/tmp/hv-published.json","utf8"));
const recorded=local.base?.publishedRevision, live=remote.result?._rev;
console.log("overlay recorded base rev:", recorded);
console.log("staging current      rev:", live);
console.log(recorded===live ? "PASS — base has not moved and was not moved by us"
                            : "INVESTIGATE — base differs; either someone edited staging, or we did");
'
```

A mismatch is **not automatically a failure** — the base is live and someone else may legitimately have edited it. But it must be explained before this run is signed, because the alternative explanation is a write escape.

**Then, finally:**

```bash
grep -c '"method":"POST"' "$VALIDATION_ROOT/proxy-log.jsonl"
grep '"method":"POST"' "$VALIDATION_ROOT/proxy-log.jsonl" | grep -v '"blocked":true' | head
```

**Expect:** every POST that reached the proxy is either a known non-content endpoint or carries `"blocked":true`.

> **Also known — do not report as new:** the write guard has an open **P1** bypass as of 2026-08-06 (a percent-encoded `?`/`#` truncates the classified path, in both guard implementations), recorded in [security-review-2026-08-06.md](security-review-2026-08-06.md). A clean proxy log is therefore not by itself proof that nothing escaped. **H27 and H28 are the independent oracles**, and they are the ones that carry this section's claim.

> **Known and already recorded — do not report as new:** interception is **not total**. CDP-layer capture on 2026-08-04 found **4 × `POST https://api.sanity.io/vX/intake/feedback`** going direct, bypassing the proxy entirely. That is telemetry, not content, and Gate A's *"0 direct requests to Sanity"* claim is **withdrawn** on those grounds. The proxy log cannot see those requests by construction, so their absence from it proves nothing.

---

## 12. Result record

Fill this in as you go. An empty cell is a step that was not run, which is different from a step that passed.

**Run metadata**

| Field | Value |
|---|---|
| Validator (name) | |
| Date | |
| Time started / finished | |
| Git commit (`git rev-parse --short HEAD`) | |
| Working tree clean? (`git status --porcelain \| wc -l`) | |
| `node --version` | |
| `sanity` version in `examples/kitchen-sink/package.json` | |
| `@sanity/client` version | |
| Browser and version | |
| `VALIDATION_ROOT` path | |
| Studio path taken (product / spike) | |

**Steps**

| # | Step | Result | Notes / verbatim failure text |
|---|---|---|---|
| H1 | Studio boots on the overlay | | |
| H2 | Traffic goes through the proxy | | |
| H3 | Hosted features absent | | |
| H4 | Non-ASCII scalar edit reaches disk | | value on disk: |
| H5 | Edit survives reload | | |
| H6 | Edit survives server restart | | |
| H7 | Caret does not jump on save | | final string: |
| H8 | Selection survives a save | | final string: |
| H9 | Fast typing not throttled into loss | | length: |
| H10 | Save indicator settles | | |
| H11 | Portable Text block written | | first `_key`: |
| H12 | First block `_key` stable | | |
| H13 | Mid-block edit lands at the caret | | |
| H14 | Mark applies across a save boundary | | |
| H15 | Publish settles | | |
| H16 | Unpublish settles | | |
| H17 | Discard changes settles | | |
| H18 | Duplicate settles | | new id: |
| H19 | Delete uses a tombstone | | |
| H20 | Confirm dialog blocks (Cancel = no-op) | | hash before / after: |
| H21 | Conflict panel state | | which of the three: |
| H22 | Guard 403 does not log out | | |
| H23 | Signed out ⇒ read-only, no disk write | | |
| H24 | Reload restores writes | | |
| H25 | Listener drop recovers | | |
| H26 | HTTP/1.1 ceiling probe | | panes open: outcome: |
| H27 | No branch content upstream | | |
| H28 | Base revision matches | | recorded / live: |

**Artifacts to keep**

- `"$VALIDATION_ROOT/proxy-log.jsonl"` — the run's server-side log. Copy it to `docs/plans/evidence/phase-1/human-validation-<date>-proxy-log.jsonl`.
- `"$VALIDATION_ROOT/.sanity-overlay/"` — the overlay the run produced.
- `/tmp/hv-published.json`, `/tmp/hv-draft.json` — the upstream oracle responses.

**Sign-off**

> I ran the steps above myself, at a keyboard, in a browser. The results recorded are what I observed.
>
> Name: ______________________  Date: ______________  Signature: ______________________

---

## 13. What a completed run does and does not close

**Closes**, if every step passes: the §0.6 human-validation requirement for **Gate A** (Studio data-plane interception) and **Gate B** (listener and editor-state protocol), including the input-device half of §21.4.1 criterion 2 that [gate-review](gate-review.md) row B currently concedes as unmeasured. Update the gate-review header line from *"Human validation: OUTSTANDING for every gate"* to name the gates this run covers and the date.

**Does not close**, whatever the result: **Gate C**, **Gate F** and the deployed half of **Gate E** — all three wait on a Vercel project and a private Blob token, and none of them has code to validate. **Gate D** (query parity) is discharged by the executable evidence in [spike-c-groq-corpus/](spike-c-groq-corpus/), not by a browser; the only browser-visible part of it is that the Studio's list panes render at all, which H26 touches incidentally.

**Does not make `[M-LOCAL]` signable.** Four separate blockers stand between the code and PRD §38.1, and this run addresses one of them. See the [phase-3 acceptance audit](../phase-3/acceptance-audit.md) §1.
