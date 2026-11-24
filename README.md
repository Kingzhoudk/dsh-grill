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

- The mode is **per Session and log-derived**. `/grill on`, `/grill off`,
  `/grill toggle` and `/grill status` are ordinary slash commands; a `grill`
  session projection folds the existing `command/run` / `command/done` events,
  so resume, fork and replay restore the switch position without any custom
  session event type. `toggle` is resolved inside the fold from the state it
  applies to, so replaying `toggle` twice lands where the user saw it land.
- While the folded state is active, the host contributes the `grill:policy`
  prompt section to every model request of that Session (placed just after the
  plan-mode policy section). Inactive Sessions carry no extra prompt text.
- The composer switch is only a surface: clicking it executes `/grill on` or
  `/grill off` through the same command path, and the projection frame updates
  the switch. There is no separate client-side mode state.
- The command is also usable directly: type `/grill`, `/grill on`,
  `/grill off`, `/grill toggle` or `/grill status` in any conversation.
  `/grill` with no argument turns the mode **on** (only `toggle` flips it).
- **Subagents.** A forked subagent is seeded with the parent's log prefix, so an
  enabled mode reaches it and the protocol applies there too. A *spawned*
  subagent starts from a fresh log with no `/grill` event of its own, so the
  host inherits an active parent through the parent's live agent or its durable
  projection — that inheritance survives a restart. An explicit `/grill off` in
  the child outranks the inherited value. A delegated child cannot ask a human
  (its `ask_user_question` is refused with `DELEGATED_CALLER`), so the protocol
  carries a subagent exception that turns a blocking question into "report it in
  your final result". That exception is appended to the built-in text and to any
  custom `section` (see Configuration).

## Environments without a composer

The composer switch is only a surface; the host half needs nothing but a command
registry and a system-prompt section, so the mode is available in every DSH
environment:

| Environment | How the mode is selected |
| --- | --- |
| Web / Desktop | the composer switch, or any `/grill …` command |
| IM relay (Feishu/WeChat/…) | the `/grill …` command in the chat; that plugin's question cards answer `ask_user_question` |
| ACP / SDK client | the `/grill …` command over the session's command endpoint |
| `dsh headless`, scheduled prompt | `defaultActive: true` on the row (nobody can type a command first), or a resumed session that already carries the state |

`ask_user_question` is not always answerable: a headless one-shot run, an ACP/SDK
client, a scheduled task or a preset without the tool rejects it with
`NO_PROVIDER`, and a delegated child gets `DELEGATED_CALLER`. The host therefore
appends an **environment exception** to the protocol: the agent writes the
blocking question and its recommended option into the answer, continues on the
recommendation when the work is reversible, and stops before an irreversible
step so the next message can approve it. The exception is appended to the
built-in text and to any custom `section` unless that section already names
`NO_PROVIDER` (see Configuration).

When a plan-mode policy section is present, that policy owns the plan-and-stop
mechanism: grill keeps its analysis and questions, folds its plan requirements
into the submitted plan, and asks for approval once instead of twice.

## Bundle layout

| File | Role |
| --- | --- |
| `index.js` | Host half: projection unit, `/grill` command, `grill:policy` prompt section, row-config validation |
| `client.js` | Browser half (Web/Desktop): the composer switch registered in `conversation.input.left` |
| `cordis.patch.yml` | Inserts the Host row into the profile |
| `locale/*.json` | Plugin Manager metadata (title/description) |
| `icon.svg` | Original artwork for the plugin inventory |
| `scripts/test.mjs` | Runs both integration scripts against a DSH source checkout |
| `tests/*.mts` | Integration scripts for the host and browser halves |

## Configuration

The plugin row accepts four optional fields:

```yaml
- id: grill
  name: 'dsh-grill'
  config:
    section: |-
      ...custom model-facing protocol text...
    appendSubagentNote: true
    appendEnvironmentNote: true
    defaultActive: false
```

`section` replaces the default prompt protocol; leave it out (or blank) to use
the built-in text documented above. `appendSubagentNote` (default `true`)
appends the subagent exception to whichever text is in effect, so overriding
the protocol never re-enables `ask_user_question` inside a delegated child. Set
it to `false` only when the custom `section` already carries its own delegated
agent rule; an author-supplied text that names `DELEGATED_CALLER` is detected
and left alone.

`appendEnvironmentNote` (default `true`) appends the environment exception
described above, on the same terms as the subagent one: a custom `section` that
already names `NO_PROVIDER` is left alone, and setting the flag to `false` opts
out. `defaultActive` (default `false`) starts every Session in interrogation
mode, which is how a one-shot environment preselects the mode; `/grill off`
still turns it off, and the choice is durable per Session.

Invalid configuration fails the read at plugin load instead of being ignored:
`section` must be a string, the two append flags and `defaultActive` must be
booleans, unknown keys are rejected with the key names, a blank `section` falls
back to the built-in text, and the effective protocol text is capped at 20000
characters.

## Install

Install the bundle from its git repository:

```sh
dsh plugin add github:Kingzhoudk/dsh-grill
# or the explicit git spec
dsh plugin add git+https://github.com/Kingzhoudk/dsh-grill.git
```

The plugin manager records the dependency and enables the bundle. The Host row
activates through the live profile patch; the browser half is served as a client
module and appears in the composer of every conversation after the page picks up
the new client graph.

The package declares `engines.dsh: ">=0.2.2-rc.1 <0.3.0"`, so the plugin manager
refuses it on an incompatible runtime. The range is written explicitly because
prereleases participate in the check and `^0.2.2` would reject `0.2.2-rc.1`.

## Testing

`tests/*.mts` are integration programs, not `node:test` suites: they import real
Harness internals, so they need a DSH source checkout on the module-resolution
path. `scripts/test.mjs` copies them into that checkout, runs both with `tsx`,
and removes the scratch directory:

```bash
# from this package
DSH_CHECKOUT=/path/to/deepseek-harness node scripts/test.mjs   # or: DSH_CHECKOUT=... npm test
```

`DSH_CHECKOUT` is required and must point at a deepseek-harness source checkout;
`DSH_GRILL_PLUGIN` defaults to this package. The runner exits non-zero when a
script fails or the checkout lacks `tsx`, `jsdom`, or `@testing-library/react`.
It prints `GRILL_HOST_INTEGRATION_OK` / `GRILL_CLIENT_OK` on success.

## Verification

Both halves were exercised before delivery and are re-exercised by `npm test`:

- **Host** — a real Harness host context (session log, projection registry,
  system prompt, command registry, agent loop with a scripted LLM adapter) runs
  with the plugin mounted. `/grill on` commits through the real command
  executor and publishes `{ active: true }` on the client-visible `grill`
  projection; the next model request's system prompt carries the protocol (and
  its subagent and environment exceptions); `/grill off` removes it; an invalid
  argument errors without changing state; `/grill status` reports the effective
  state and `/grill toggle` flips the durable one. The fold is checked directly
  for replay safety, `toggle` resolution and reference stability; the state view
  is checked for spawned-child inheritance and explicit-off precedence; a real
  spawned subagent created on the host is shown to inherit the mode and receive
  the protocol; and the row config is checked for type, unknown-key, size and
  duplicate-marker rejection.
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
new client module graph. Non-Web environments were not booted here: the host
half is exercised directly (command registry, projection, prompt assembly), and
the environment exception is asserted in the prompt text, but no live IM,
ACP/SDK or headless run is part of this suite.

## Uninstall

Remove the bundle with the Harness plugin manager (`remove_bundle`,
target `dsh-grill`); the profile patch selection and dependency entry are
cleaned up by the manager.

## License

MIT — see [LICENSE](LICENSE).
