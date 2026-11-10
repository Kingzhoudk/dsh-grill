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
 *  6. checks the pure projection fold directly (resume/replay semantics).
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

const adapter = new MockAdapter([textResponse('ok'), textResponse('ok'), textResponse('ok')])
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
assert.equal(Grill.resolveGrillConfig({ section: 'custom', appendSubagentNote: false }).section, 'custom', 'the exception can be opted out')
assert.throws(() => Grill.resolveGrillConfig({ section: 42 }), TypeError, 'non-string section is rejected')
assert.throws(() => Grill.resolveGrillConfig({ section: '', bogus: true }), /unknown config key/u, 'unknown keys are rejected')
assert.throws(() => Grill.resolveGrillConfig({ section: 'x'.repeat(20_001) }), RangeError, 'oversized section is rejected')

await ctx.dispose?.()
console.log('GRILL_HOST_INTEGRATION_OK')
