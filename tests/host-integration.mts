/**
 * Integration check for the 拷问 (Grill) host half.
 *
 * Runs a real Harness host context (session log, projections, system prompt,
 * commands, agent loop + scripted LLM adapter) with the plugin mounted, then:
 *  1. folds `/grill on` through the real command executor,
 *  2. reads the client-visible projection value,
 *  3. runs one agent turn and asserts the protocol section is in the system
 *     prompt,
 *  4. repeats for `/grill off` and asserts the section is gone,
 *  5. rejects an invalid argument without changing state,
 *  6. checks the pure projection fold directly (resume/replay semantics),
 *  7. checks `/grill status|toggle` and the effective-state view (spawned-child
 *     inheritance, explicit-off precedence, `defaultActive`),
 *  8. checks the row config grows the environment exception without duplicates.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandsRuntime from '@deepseek-ai/dsh-commands'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

// scripts/test.mjs sets both variables; a hand-run copy must export them too.
const CHECKOUT = process.env.DSH_CHECKOUT
const PLUGIN = process.env.DSH_GRILL_PLUGIN
if (CHECKOUT === undefined || PLUGIN === undefined) {
  throw new Error('set DSH_CHECKOUT (a deepseek-harness checkout) and DSH_GRILL_PLUGIN (this package)')
}
const { MockAdapter, textResponse } = await import(
  pathToFileURL(join(CHECKOUT, 'packages/core/agent-loop/tests/mock-adapter.ts')).href
)
const Grill = await import(pathToFileURL(join(PLUGIN, 'index.js')).href)

const MARKER = 'Interrogation mode (拷问)'

function waitForIdle(ctx, agent) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { dispose(); reject(new Error('agent did not go idle')) }, 10_000)
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      clearTimeout(timer)
      dispose()
      resolve()
    })
  })
}

function systemText(request) {
  const system = request.messages.find(message => message.role === 'system')
  if (system === undefined) return ''
  return system.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SystemPrompt, { personaPrefix: 'stable base' })
await ctx.plugin(ToolRuntime)
await ctx.plugin(NativeToolExecutor)
await ctx.plugin(AgentRegistry)
await ctx.plugin(CommandsRuntime)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(Grill)

const adapter = new MockAdapter([textResponse('ok'), textResponse('ok'), textResponse('ok'), textResponse('ok')])
ctx.llm.registerAdapter(['mock'], adapter)
const agent = await ctx.agentLoop.create(SessionId('grill-test'), { provider: 'mock', model: 'mock' })
const signal = new AbortController().signal

// 0. default state: off, no prompt section
assert.deepEqual(ctx.sessionProjections.snapshot(agent.session).values.grill, { active: false })

// 1. /grill on commits through the real command path
const on = await ctx.commands.execute(agent, '/grill on', [], signal)
assert.equal(on?.result.kind, 'success', 'on command succeeds')
assert.deepEqual(ctx.sessionProjections.snapshot(agent.session).values.grill, { active: true })

// 2. the next model request carries the protocol section
agent.followup(createUserMessage({ content: [{ type: 'text', text: '整理一下这个需求' }], source: { kind: 'user' } }))
await waitForIdle(ctx, agent)
const withSection = systemText(adapter.requests[0])
assert.ok(withSection.includes(MARKER), 'active session system prompt carries the protocol')
assert.ok(withSection.includes('ask_user_question'), 'protocol names the question tool')
assert.ok(withSection.includes('BLOCKING'), 'protocol classifies findings')
assert.ok(withSection.includes('DELEGATED_CALLER'), 'protocol carries the subagent exception')

// 3. /grill off removes the section from later requests
const off = await ctx.commands.execute(agent, '/grill off', [], signal)
assert.equal(off?.result.kind, 'success')
assert.deepEqual(ctx.sessionProjections.snapshot(agent.session).values.grill, { active: false })
agent.followup(createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }))
await waitForIdle(ctx, agent)
assert.ok(!systemText(adapter.requests[1]).includes(MARKER), 'inactive session has no protocol section')

// 4. an unrecognized argument is an error and leaves the mode untouched
const bad = await ctx.commands.execute(agent, '/grill perhaps', [], signal)
assert.equal(bad?.result.kind, 'error')
assert.deepEqual(ctx.sessionProjections.snapshot(agent.session).values.grill, { active: false })

// 5. pure fold: replay/replay-from-log semantics and failed-command safety
const init = Grill.grillProjection.init()
const ran = Grill.grillProjection.apply(init, {
  type: 'command/run', data: { commandId: 'c1', name: 'grill', args: ' on' },
})
assert.deepEqual(ran, { active: false, running: { commandId: 'c1', wanted: true } })
const done = Grill.grillProjection.apply(ran, {
  type: 'command/done', data: { commandId: 'c1', kind: 'success' },
})
assert.deepEqual(done, { active: true, running: null })
const failed = Grill.grillProjection.apply(ran, {
  type: 'command/done', data: { commandId: 'c1', kind: 'error' },
})
assert.deepEqual(failed, { active: false, running: null })
const unrelated = Grill.grillProjection.apply(done, { type: 'turn/start', data: { turn: 1 } })
assert.equal(unrelated, done, 'irrelevant events keep the state reference')
assert.equal(Grill.grillProjection.wire.view(init), Grill.grillProjection.wire.view(init), 'stable wire view')
assert.deepEqual(Grill.parseGrillArgument(' OFF '), false)
assert.equal(Grill.parseGrillArgument('maybe'), undefined)

// 7. status and toggle: the same command surface every non-Web environment
//    (terminal, ACP/SDK, IM, headless) uses when no composer switch exists.
const onAgain = await ctx.commands.execute(agent, '/grill on', [], signal)
assert.equal(onAgain?.result.kind, 'success')
const statusOn = await ctx.commands.execute(agent, '/grill status', [], signal)
assert.equal(statusOn?.result.kind, 'success')
assert.match(statusOn.result.text, /Interrogation mode is ON/u)
const toggled = await ctx.commands.execute(agent, '/grill toggle', [], signal)
assert.equal(toggled?.result.kind, 'success')
assert.deepEqual(ctx.sessionProjections.snapshot(agent.session).values.grill, { active: false }, 'toggle flips the durable state')
const statusOff = await ctx.commands.execute(agent, '/grill status', [], signal)
assert.match(statusOff.result.text, /Interrogation mode is OFF/u)

// 8. effective-state view: inheritance, explicit-over precedence, configured default
const view = Grill.createGrillView({})
let durable = { active: false }
view.bind(() => durable)
assert.equal(view.isActive({ id: 'child' }), false, 'a fresh child starts inactive')
view.inherit('child')
assert.equal(view.isActive({ id: 'child' }), true, 'a spawned child inherits an active parent')
view.remember({ id: 'child' }, false)
assert.equal(view.isActive({ id: 'child' }), false, 'an explicit off outranks inheritance')
assert.equal(view.isActive({ id: 'child' }), false, 'and it stays off once the fold agrees')
durable = { active: true }
assert.equal(view.isActive({ id: 'parent' }), true, 'the durable fold is authoritative')
const defaultOn = Grill.createGrillView({ defaultActive: true })
assert.equal(defaultOn.isActive({ id: 'fresh' }), true, 'defaultActive preselects the mode')
assert.deepEqual(Grill.createGrillProjection({ defaultActive: true }).init(), { active: true, running: null })
assert.deepEqual(Grill.createGrillProjection().init(), { active: false, running: null })

// 6. row config: invalid values fail loud, the subagent exception survives a
//    custom `section`, and it is the default for the built-in text.
const builtIn = Grill.resolveGrillConfig({})
assert.ok(builtIn.section.includes(MARKER), 'default protocol text stays in place')
assert.ok(builtIn.section.includes('DELEGATED_CALLER'), 'default protocol carries the subagent exception')
assert.equal(builtIn.appendSubagentNote, true)
const custom = Grill.resolveGrillConfig({ section: 'custom protocol' })
assert.ok(custom.section.startsWith('custom protocol'), 'custom section replaces the default text')
assert.ok(custom.section.includes('DELEGATED_CALLER'), 'custom section still carries the subagent exception')
assert.equal(Grill.resolveGrillConfig({ section: '   ' }).section, builtIn.section, 'blank section falls back to the default')
const bare = Grill.resolveGrillConfig({ section: 'custom', appendSubagentNote: false, appendEnvironmentNote: false })
assert.equal(bare.section, 'custom', 'both appended exceptions can be opted out')
assert.equal(Grill.resolveGrillConfig({ section: 'custom', appendSubagentNote: false }).section.includes('Environment fallback'), true,
  'opting out of the subagent exception keeps the environment one')
assert.ok(builtIn.section.includes('NO_PROVIDER'), 'default protocol carries the no-human environment exception')
assert.equal(builtIn.appendEnvironmentNote, true)
assert.equal(builtIn.defaultActive, false, 'the mode stays off by default')
assert.ok(!Grill.resolveGrillConfig({ appendEnvironmentNote: false }).section.includes('NO_PROVIDER'),
  'the environment exception can be opted out')
const envOwn = Grill.resolveGrillConfig({ section: 'custom NO_PROVIDER text' })
assert.ok(!envOwn.section.includes('Environment fallback'), 'an author-supplied environment exception is not duplicated')
assert.ok(envOwn.section.includes('DELEGATED_CALLER'), 'the subagent exception is still appended')
assert.throws(() => Grill.resolveGrillConfig({ section: 42 }), TypeError, 'non-string section is rejected')
assert.throws(() => Grill.resolveGrillConfig({ defaultActive: 'yes' }), TypeError, 'non-boolean defaultActive is rejected')
assert.throws(() => Grill.resolveGrillConfig({ appendEnvironmentNote: 1 }), TypeError, 'non-boolean appendEnvironmentNote is rejected')
assert.throws(() => Grill.resolveGrillConfig({ section: '', bogus: true }), /unknown config key/u, 'unknown keys are rejected')
assert.throws(() => Grill.resolveGrillConfig({ section: 'x'.repeat(20_001) }), RangeError, 'oversized section is rejected')

// 9. a spawned subagent whose own log holds no /grill event inherits an active
//    parent, and the protocol reaches the child's model request.
const parentOn = await ctx.commands.execute(agent, '/grill on', [], signal)
assert.equal(parentOn?.result.kind, 'success')
const child = await ctx.agentLoop.create(
  SessionId('grill-child'),
  { provider: 'mock', model: 'mock' },
  { parentSession: agent.session.id, origin: 'subagent' },
)
const deadline = Date.now() + 2000
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 20))
  if (ctx.sessionProjections.snapshot(agent.session).values.grill?.active === true) break
}
child.followup(createUserMessage({ content: [{ type: 'text', text: '子任务' }], source: { kind: 'user' } }))
await waitForIdle(ctx, child)
const childPrompt = systemText(adapter.requests[adapter.requests.length - 1])
assert.ok(childPrompt.includes(MARKER), 'a spawned subagent inherits interrogation mode from its parent')

await ctx.dispose?.()
console.log('GRILL_HOST_INTEGRATION_OK')
