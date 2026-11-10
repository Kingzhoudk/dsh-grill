/**
 * Client-half check for the 拷问 (Grill) composer switch.
 *
 * Loads the real browser bundle through a stand-in `window.__ModuleLoader__`,
 * mounts the registered slot component with the Harness React instance used by
 * @testing-library/react, and exercises the interactions the composer will:
 *  - renders a role="switch" with the initial state from the `grill` projection;
 *  - clicking the off switch executes `/grill on` through the injected command
 *    service and does not keep local mode state;
 *  - clicking the on switch executes `/grill off`;
 *  - a failed command surfaces as the switch title instead of crashing the slot;
 *  - missing optional props degrade instead of throwing (slot entry safety).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Node = dom.window.Node
globalThis.Event = dom.window.Event
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// scripts/test.mjs sets both variables; a hand-run copy must export them too.
const CHECKOUT = process.env.DSH_CHECKOUT
const PLUGIN = process.env.DSH_GRILL_PLUGIN
if (CHECKOUT === undefined || PLUGIN === undefined) {
  throw new Error('set DSH_CHECKOUT (a deepseek-harness checkout) and DSH_GRILL_PLUGIN (this package)')
}

const testingLibraryDir = fs.realpathSync(`${CHECKOUT}/node_modules/@testing-library/react`)
const requireClient = createRequire(`${testingLibraryDir}/package.json`)
const React = requireClient('react')
const { render, fireEvent, cleanup, waitFor, act } = requireClient('@testing-library/react')

let registration
dom.window.__ModuleLoader__ = {
  load(value) {
    assert.equal(registration, undefined, 'the bundle registers exactly once')
    registration = value
  },
}
await import(pathToFileURL(`${PLUGIN}/client.js`).href)
assert.ok(registration !== undefined, 'bundle registered a module')
assert.equal(registration.id, 'dsh-grill')

const requireForBundle = (name) => {
  if (name === 'react') return React
  throw new Error(`unexpected external module ${JSON.stringify(name)}`)
}
const plugin = registration.factory(requireForBundle)
assert.deepEqual(plugin.inject, ['slots', 'locale', 'remote', 'remote.commands'])

const executeCalls = []
const ctx = {
  effect(callback) {
    const dispose = callback()
    return () => { dispose?.() }
  },
  locale: {
    registered: [],
    register(ns, locale, dict) {
      this.registered.push([ns, locale, dict])
      return () => {}
    },
  },
  slots: {
    registeredEntries: [],
    inject(key, callback) {
      assert.equal(key, 'conversation.input.left')
      return callback()
    },
    register(options, component) {
      this.registeredEntries.push({ options, component })
      return () => {}
    },
  },
  remote: {
    commands: {
      execute(...args) {
        executeCalls.push(args)
        return Promise.resolve({ ok: true, value: { commandId: 'cmd-1', result: { kind: 'success' } } })
      },
    },
  },
}

plugin.apply(ctx)
assert.deepEqual(ctx.locale.registered.map(entry => entry.slice(0, 2)), [['grill', 'en'], ['grill', 'zh']])
assert.equal(ctx.slots.registeredEntries.length, 1)
const entry = ctx.slots.registeredEntries[0]
assert.equal(entry.options.id, 'grill-switch')
assert.equal(entry.options.locale, 'grill')
assert.equal(entry.options.order, 10)
assert.equal(typeof entry.component, 'function')

// The composer passes the standard props; `t` is identity here so assertions
// compare dictionary keys.
function props(overrides = {}) {
  return {
    sessionId: 'session-1',
    t: key => key,
    useProjection: () => overrides.projection,
    useSession: selector => selector({ removed: false }),
    useAccess: () => true,
    ...overrides.props,
  }
}

const view = render(React.createElement(entry.component, props()))
let toggle = view.getByRole('switch')
assert.equal(toggle.getAttribute('aria-checked'), 'false')
assert.equal(toggle.getAttribute('aria-label'), 'aria.off')
assert.ok(toggle.textContent.includes('label'), 'the switch carries its localized label')
assert.equal(document.querySelectorAll('style').length, 1, 'component owns exactly one stylesheet')
assert.ok(document.querySelector('style').textContent.includes('--dsw-alias-brand-primary'), 'styles use theme tokens')

await act(async () => { fireEvent.click(toggle) })
assert.equal(executeCalls.length, 1)
assert.deepEqual(executeCalls[0], ['session-1', '/grill on', []])

// A pushed projection frame moves the switch; no local mode state exists.
cleanup()
const active = render(React.createElement(entry.component, props({ projection: { active: true } })))
toggle = active.getByRole('switch')
assert.equal(toggle.getAttribute('aria-checked'), 'true')
assert.equal(toggle.getAttribute('aria-label'), 'aria.on')
await act(async () => { fireEvent.click(toggle) })
assert.deepEqual(executeCalls[1], ['session-1', '/grill off', []])

// A rejected command shows the failure in the title and leaves the slot alive.
cleanup()
const failure = { ok: false, error: { code: 'COMMAND_FAILED', message: 'boom' } }
ctx.remote.commands.execute = (...args) => { executeCalls.push(args); return Promise.resolve(failure) }
const failed = render(React.createElement(entry.component, props()))
toggle = failed.getByRole('switch')
await act(async () => { fireEvent.click(toggle) })
await waitFor(() => {
  const current = failed.getByRole('switch')
  assert.ok(current.getAttribute('title').includes('boom'), `title carries the failure, got ${current.getAttribute('title')}`)
  assert.equal(current.getAttribute('data-error'), '')
})

// The command endpoint's access answer gates the switch: the gate asks
// `commands/execute` (not `session/prompt`) and only falls back to the Session
// seat when the global one is unavailable.
cleanup()
const denied = render(React.createElement(entry.component, props({ props: { useRemoteAccess: () => false } })))
assert.equal(denied.getByRole('switch').disabled, true, 'a denied commands/execute disables the switch')
cleanup()
const allowed = render(React.createElement(entry.component, props({ props: { useRemoteAccess: () => true } })))
assert.equal(allowed.getByRole('switch').disabled, false, 'an owner keeps the switch usable')
cleanup()
const fallback = render(React.createElement(entry.component, props({ props: { useAccess: () => false } })))
assert.equal(fallback.getByRole('switch').disabled, true, 'without the global seat the Session seat decides')
cleanup()

// An admitted command whose handler failed reports `ok: true` with an error
// outcome; that text must reach the switch instead of a false success.
ctx.remote.commands.execute = () => Promise.resolve({
  ok: true,
  value: { commandId: 'cmd-2', result: { kind: 'error', text: 'handler rejected this' } },
})
const handled = render(React.createElement(entry.component, props()))
await act(async () => { fireEvent.click(handled.getByRole('switch')) })
assert.ok(handled.getByRole('switch').getAttribute('title').includes('handler rejected this'),
  'the handler error text reaches the switch')
cleanup()

// A response that settles after the Session changed must not write into the
// new Session's switch.
let settle
ctx.remote.commands.execute = () => new Promise((resolve) => { settle = resolve })
const race = render(React.createElement(entry.component, props({ props: { sessionId: 'race-a' } })))
await act(async () => { fireEvent.click(race.getByRole('switch')) })
race.rerender(React.createElement(entry.component, props({ props: { sessionId: 'race-b' } })))
await act(async () => { settle({ ok: false, error: { code: 'LATE', message: 'late failure' } }) })
assert.ok(!(race.getByRole('switch').getAttribute('title') ?? '').includes('late failure'), 'a stale response is dropped')
cleanup()

// Missing optional seats must not blank the composer slot entry.
cleanup()
const bare = render(React.createElement(entry.component, { sessionId: 's2' }))
assert.equal(bare.getByRole('switch').getAttribute('aria-checked'), 'false')
cleanup()

console.log('GRILL_CLIENT_OK')
