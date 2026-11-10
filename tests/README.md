# Verification scripts

These are integration programs, not `node:test` suites. They run real Harness
internals (`@deepseek-ai/dsh-*` and the agent-loop mock adapter), so they must
execute **inside a DSH source checkout** on the module-resolution path (Node
ignores `NODE_PATH` for ESM).

The supported way to run them is the packaged runner:

```bash
# from this package
DSH_CHECKOUT=/path/to/deepseek-harness node scripts/test.mjs   # or: DSH_CHECKOUT=... npm test
```

`scripts/test.mjs` creates a scratch directory **inside** the checkout, copies
both scripts there, runs them with `node --import tsx/esm`, removes the
directory, and exits non-zero if either script fails or the checkout is missing
`tsx`, `jsdom`, or `@testing-library/react`.

- `DSH_CHECKOUT` — checkout to run against (required; no default).
- `DSH_GRILL_PLUGIN` — plugin directory the scripts load (default: this
  package, set by the runner).

Both scripts read those absolute paths from the environment, so a hand-run copy
inside the checkout works when both are exported:

```bash
# from the checkout root
pkg=/path/to/dsh-grill
mkdir -p .grill-test
cp "$pkg"/tests/*.mts .grill-test/
DSH_CHECKOUT=$PWD DSH_GRILL_PLUGIN=$pkg node --import tsx/esm .grill-test/host-integration.mts
DSH_CHECKOUT=$PWD DSH_GRILL_PLUGIN=$pkg node --import tsx/esm .grill-test/client-integration.mts
rm -rf .grill-test
```

`host-integration.mts` boots a real host context (session log, projection
registry, system prompt, commands registry, agent loop with a scripted LLM
adapter) with the plugin mounted and asserts:

- `/grill on` commits through the real command executor and publishes
  `{ active: true }` as the client-visible `grill` projection;
- the next model request's system prompt carries the interrogation protocol and
  its subagent exception (and `/grill off` removes it from later requests);
- an invalid argument is an error and leaves the mode unchanged;
- the projection fold is pure and replay-safe (`command/run` /
  `command/done`, failed commands ignored, unrelated events keep the state
  reference);
- row-config validation rejects a non-string `section`, unknown keys, and an
  oversized text, falls back from a blank `section`, and keeps the subagent
  exception on a custom `section` unless it is opted out.

`client-integration.mts` loads the real browser bundle through a stand-in
`window.__ModuleLoader__` and mounts the registered slot component with the
Harness React instance:

- renders `role="switch"` in the off state, then the on state from the pushed
  projection;
- clicking executes `/grill on` / `/grill off` through the injected command
  service (no local mode state);
- a failed command surfaces in the switch title without crashing the slot;
- a denied `commands/execute` (or the Session-seat fallback) disables the
  switch;
- an admitted command whose handler failed shows the handler text;
- a response that settles after the Session changed does not write into the new
  Session's switch;
- missing optional props degrade instead of throwing.
