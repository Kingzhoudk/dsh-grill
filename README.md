# 拷问 (Grill) mode — DSH plugin

A per-conversation switch in the composer tool row, leading the
`conversation.input.left` group. The permission selector and the plan chip
render before that group in their own mode cluster, so the switch is not
literally adjacent to the permission selector. While it is on, every user
request must pass an analysis gate before the agent plans or executes:

1. analyze the request (goal, scope, inputs, constraints, vague terms,
   contradictions, silent assumptions);
2. classify each finding as blocking or non-blocking;
3. on any blocking finding, stop and ask through `ask_user_question`, naming the
   exact ambiguity, why it blocks, 2–4 concrete options (recommended first) and
   a concrete repair proposal;
4. re-analyze after each answer until no blocking finding remains;
5. weigh the task: trivial work (one file, read-only, reversible, obvious
   acceptance) is done directly with a one-line reading; anything non-trivial
   (multiple files, a new feature, a change to shared or user-visible behavior,
   an irreversible step, or a change to plugins/profiles/prompt policy) is
   **planned and then stopped** — no state-changing tool call until the user
   approves;
6. the non-trivial plan message carries the confirmed requirements, exact file
   paths and per-file changes, behavior before/after, verification, risks and
   rollback, the choices that would otherwise be decided silently, and a
   go-ahead line; approval is requested through `ask_user_question` in the same
   turn (`Approve and execute` / `I want to change the plan` / `Stop for now`).

The gate applies to later messages too, including short follow-ups such as
"继续" or "改一下", but a follow-up that continues an already approved plan is
acted on rather than re-planned.

## How it works

- The mode is **per Session and log-derived**. `/grill on` and `/grill off` are
  ordinary slash commands; a `grill` session projection folds the existing
  `command/run` / `command/done` events, so resume, fork and replay restore the
  switch position without any custom session event type.
- While the folded state is active, the host contributes the `grill:policy`
  prompt section to every model request of that Session (placed just after the
  plan-mode policy section). Inactive Sessions carry no extra prompt text.
- The composer switch is only a surface: clicking it executes `/grill on` or
  `/grill off` through the same command path, and the projection frame updates
  the switch. There is no separate client-side mode state.
- The command is also usable directly: type `/grill`, `/grill on` or
  `/grill off` in any conversation. `/grill` with no argument turns the mode
  **on** (it never toggles), and there is no `status` subcommand.
- **Subagents.** A forked subagent is seeded with the parent's log prefix, so an
  enabled mode reaches it and the protocol applies there too. A delegated child
  cannot ask a human — its `ask_user_question` is refused with
  `DELEGATED_CALLER` — so the protocol carries a subagent exception that turns a
  blocking question into "report it in your final result". That exception is
  appended to the built-in text and to any custom `section` (see Configuration).

## Bundle layout

| File | Role |
| --- | --- |
| `index.js` | Host half: projection unit, `/grill` command, `grill:policy` prompt section, row-config validation |
| `client.js` | Browser half: the composer switch registered in `conversation.input.left` |
| `cordis.patch.yml` | Inserts the Host row into the profile |
| `locale/*.json` | Plugin Manager metadata (title/description) |
| `icon.svg` | Original artwork for the plugin inventory |
| `scripts/test.mjs` | Runs both integration scripts against a DSH source checkout |
| `tests/*.mts` | Integration scripts for the host and browser halves |

## Configuration

The plugin row accepts two optional fields:

```yaml
- id: grill
  name: '@local/dsh-grill'
  config:
    section: |-
      ...custom model-facing protocol text...
    appendSubagentNote: true
```

`section` replaces the default prompt protocol; leave it out (or blank) to use
the built-in text documented above. `appendSubagentNote` (default `true`)
appends the subagent exception to whichever text is in effect, so overriding
the protocol never re-enables `ask_user_question` inside a delegated child. Set
it to `false` only when the custom `section` already carries its own delegated
agent rule; an author-supplied text that names `DELEGATED_CALLER` is detected
and left alone.

Invalid configuration fails the read at plugin load instead of being ignored:
`section` and `appendSubagentNote` must have their declared types, unknown keys
are rejected with the key names, a blank `section` falls back to the built-in
text, and the effective protocol text is capped at 20000 characters.

## Install

Install the bundle directory with the Harness plugin manager
(`plugin_manager`, action `install_bundle`, target = this directory). The Host
row activates through the live profile patch; the browser half is served as a
client module and appears in the composer of every conversation after the page
picks up the new client graph.

The package declares `engines.dsh: ">=0.2.2-rc.1 <0.3.0"`, so the plugin manager
refuses it on an incompatible runtime. The range is written explicitly because
prereleases participate in the check and `^0.2.2` would reject `0.2.2-rc.1`.

## Testing

`tests/*.mts` are integration programs, not `node:test` suites: they import real
Harness internals, so they need a DSH source checkout on the module-resolution
path. `scripts/test.mjs` copies them into that checkout, runs both with `tsx`,
and removes the scratch directory:

```bash
cd /home/dk/test/plugins/dsh-grill
DSH_CHECKOUT=/home/dk/study/deepseek-harness node scripts/test.mjs   # or: npm test
```

`DSH_CHECKOUT` defaults to `/home/dk/study/deepseek-harness` and
`DSH_GRILL_PLUGIN` to this package, so a hand-run copy inside the checkout still
works unchanged. The runner exits non-zero when a script fails or the checkout
lacks `tsx`, `jsdom`, or `@testing-library/react`. It prints
`GRILL_HOST_INTEGRATION_OK` / `GRILL_CLIENT_OK` on success.

## Verification

Both halves were exercised before delivery and are re-exercised by `npm test`:

- **Host** — a real Harness host context (session log, projection registry,
  system prompt, command registry, agent loop with a scripted LLM adapter) runs
  with the plugin mounted. `/grill on` commits through the real command
  executor and publishes `{ active: true }` on the client-visible `grill`
  projection; the next model request's system prompt carries the protocol (and
  its subagent exception); `/grill off` removes it; an invalid argument errors
  without changing state. The fold is checked directly for replay safety and
  reference stability, and the row-config validation is checked for type,
  unknown-key, and size rejection.
- **Client** — the real `client.js` bundle is loaded through a stand-in
  `window.__ModuleLoader__` and the registered slot component mounted with the
  Harness React instance: it renders `role="switch"` in both states, clicking
  executes `/grill on` / `/grill off`, a failed command surfaces in the title
  without crashing the slot, a denied `commands/execute` disables it, a handler
  error outcome is shown, a response that settles after a Session switch is
  dropped, and missing optional props degrade gracefully.
- **Installed profile** — the bundle installs with `application: applied`, the
  host row reports `fiberPhase: active`, the live page's
  `conversation.input.left` slot lists the active `grill-switch` occupant at
  `order: 10` (leading that group; the permission selector and plan chip render
  before the group), and the localized Plugin Manager title/description and icon
  resources resolve from the package.

Not verified without browser control: the rendered pixels (exact spacing and
light/dark appearance) and a literal mouse click in the running page. If an
already-open tab does not show the switch, refresh the page once to pick up the
new client module graph.

## Uninstall

Remove the bundle with the Harness plugin manager (`remove_bundle`,
target `@local/dsh-grill`); the profile patch selection and dependency entry are
cleaned up by the manager. The checkout at `/home/dk/test/plugins/dsh-grill` is
left untouched.
