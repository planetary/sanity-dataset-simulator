# sanity-overlay (CLI)

The command-line tool for running and inspecting a branch overlay. If you're new to the project, read the [root README](../../README.md) first for what an overlay *is*.

## Run the overlay: `sanity-overlay dev`

This is the front door. From the directory that contains (or should contain) `.sanity-overlay/`:

```bash
sanity-overlay dev
```

- **Overlay already exists** → it's adopted as-is and served.
- **Fresh directory, Sanity project known** → `sanity-overlay dev --project <id> --dataset <name>` creates the overlay first. The identity is stamped into the manifest, so it's asked for explicitly, never guessed.
- **Fresh directory, no Sanity project yet** → `sanity-overlay dev --detached` creates the overlay with a sentinel identity (`detached.local`). This is the common cold start: build the UI and seed content now, provision the Sanity project later. Everything works locally — in `fs` mode nothing ever contacts Sanity, so the identity is just a label. When the real project exists, run [`sanity-overlay attach`](#attach-a-detached-overlay-later).

Once it's up, the output tells you everything you need next: the port, the health URL, the env lines to paste into your Studio and your site, and the inspection commands below.

| Flag | Default | Meaning |
|---|---|---|
| `--root <dir>` | the current directory | Directory containing `.sanity-overlay/`. Every command takes it; you rarely need it |
| `--port <n>` | 3998 | API port; `0` picks a free one |
| `--studio-origin <url>` | `http://localhost:3333` | The one origin granted CORS (the API serves your whole branch, drafts included, so the grant is single-origin by design) |
| `--project` / `--dataset` / `--api-version` | — | Base identity, only when creating |
| `--detached` | off | Create with no Sanity project (see above) |
| `--id <overlayId>` | derived | Explicit overlay id when creating |
| `--branch` / `--repository` | `local:<dirname>` | Source labels stamped into the manifest |
| `--json` | off | Machine-readable startup report |

**When you don't need `dev` at all:** if your Next.js app mounts the overlay API routes from `sanity-overlay-next` ([its README](../sanity-overlay-next/README.md)), your normal `next dev` already runs everything.

## Attach a detached overlay later

Once the real Sanity project exists, bind the overlay to it:

```bash
sanity-overlay attach --project <sanityProjectId> --dataset <name> --confirm
```

The rebind goes through the store like every other manifest change (a conditional write, which is also the revision increment), rather than a hand-edit of `manifest.json`. Same discipline as the other state-changing commands: without `--confirm` it prints the rebind and exits 3; `--dry-run` shows the plan and writes nothing even alongside `--confirm`.

Two refusals worth knowing:

- **An already-attached overlay needs `--force`.** Every captured base revision in the branch was read from the current project, so pointing the manifest elsewhere is a claim only the operator can make — legitimate for a dataset copy or a project migration, but it has to be said out loud.
- **A project id containing a dot is rejected.** Real Sanity project ids can't contain one; accepting it would leave the overlay looking detached forever.

## Inspect and operate the branch

Run these from your project directory (or add `--root <dir>` to point elsewhere):

```bash
sanity-overlay status       # one screen: revision, documents, conflicts, checkpoint
sanity-overlay diff         # what the branch changed vs its base, per field
sanity-overlay conflicts    # unresolved conflicts; exit code 2 if any (CI-friendly)
sanity-overlay conflicts --resolve <docId> --action <action> --confirm   # record a resolution
sanity-overlay validate     # run the format invariants and checksums (read-only)
sanity-overlay history      # the branch's transaction log, in order
sanity-overlay export --bundle out.json   # portable checkpoint; `import` restores it
sanity-overlay ci           # the whole CI checklist with one exit code
```

Full command list: `sanity-overlay --help`. Three properties to rely on:

- **Destructive commands (`reset`, `rebase`, `cleanup`, `conflicts --resolve`) never write without `--confirm`**, all support `--dry-run`, and `--dry-run` wins even when both are passed.
- **Exit codes are a contract**: `0` clean · `1` internal bug · `2` findings · `3` confirmation required · `4` overlay missing/corrupt · `5` usage error · `6` query refused. `2` is not a crash — it means the command ran and found something.
- **Everything printed passes through a credential redactor**, so output is safe to paste into a ticket.
