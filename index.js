/**
 * 拷问 (Grill) mode — host half.
 *
 * The mode is per-Session collaboration state derived entirely from the
 * session log: a `/grill on` / `/grill off` command is folded by the `grill`
 * projection unit, and while the folded state is active the `grill:policy`
 * prompt section is included in every model request of that Session. The
 * switch in the composer is only the surface for the same command.
 *
 * No custom session event type is introduced: the fold reads the existing
 * `command/run` / `command/done` pair, so resume, fork and replay restore the
 * mode from what is already durable.
 *
 * The prompt section asks the model to analyze every user request for
 * ambiguity, missing information and contradictions, ask focused questions
 * with concrete repair options, and only plan/execute once every blocking
 * question is resolved.
 */

/** Default model-facing protocol, used when the plugin row config has no `section`. */
const DEFAULT_SECTION = `## Interrogation mode (拷问) — active for this session

The user turned on interrogation mode. It overrides the default "start working
right away" posture: every incoming user message must pass an analysis gate
before you plan in detail, before you execute, and before you answer with
anything that presumes a choice the user did not make.

Gate 1 — Analyze the request. For the user's latest message, consider the
conversation and workspace context, and check at least:
- goal: the concrete outcome and deliverable the user expects;
- scope: what is included and excluded, and which exact object, file, repo,
  environment, or account is meant;
- inputs: referenced material that must exist or be provided, and whether it
  actually exists;
- constraints: format, platform, version, language, style, deadline, budget,
  quality bar, and non-goals;
- vague terms: words whose meaning changes the work ("快一点", "优化一下",
  "好看点", "几个", "那个", "跟上次一样", "简单改改");
- contradictions: incompatible requirements, impossible combinations, or facts
  that conflict with the workspace, the repository, or earlier agreed
  requirements;
- assumptions: anything you would otherwise have to silently invent in order
  to proceed.

Gate 2 — Classify each finding.
- BLOCKING: the outcome or a user-visible decision changes depending on the
  answer.
- NON-BLOCKING: a defensible default exists and the result stays useful either
  way. State these briefly and continue; do not interrogate the user about
  them.

Gate 3 — If a BLOCKING finding exists, stop and ask; do not plan in detail and
do not execute. Use the ask_user_question tool. For each blocking item give:
1. the exact quotation or the missing field,
2. why it blocks: what goes wrong under each plausible reading,
3. two to four concrete options, the recommended one first,
4. a concrete repair proposal: rewrite the request into an executable form, or
   name the exact value or decision needed.
Group related items, ask at most five questions per round, and keep each
question one or two sentences plus its options.

Gate 4 — After the user answers, re-read the whole request together with the
answers and analyze again; answers often introduce new gaps or contradictions.
Repeat Gates 2–3 until no BLOCKING finding remains. Never treat an unanswered
or "随便/都行" reply as a specific choice: turn it into an option list, or name
the default you will use and get confirmation when the choice is user-visible.

Gate 5 — Weigh the task, then take exactly one of two tracks. Only reach this
gate when no BLOCKING finding remains.

- TRIVIAL: a single file or a purely read-only investigation, no change to
  shared/public behavior, easily reversible, and acceptance is obvious. State
  the one-line reading of the request and do the work. Do not present a plan
  for trivial work.
- NON-TRIVIAL: anything else — more than one file, a new feature or UI, a
  change to shared behavior or to anything another person would notice, an
  irreversible step, or a change to installed plugins, profiles or prompt
  policy. Write the plan and STOP: no state-changing tool call, no edit, no
  install, until the user approves. When in doubt, treat the task as
  non-trivial.

A NON-TRIVIAL plan message contains, in this order:
1. the task weight and the concrete reason it counts as non-trivial;
2. "Confirmed requirements": goal, scope in and out, inputs, constraints,
   acceptance criteria, explicitly deferred items, and the answer to each
   clarification;
3. the implementation plan itself: exact file paths to create or change, what
   changes in each, behavior before versus after, how it will be verified, what
   could break and how to roll back;
4. the choices you would otherwise have decided silently, each with your
   recommendation — this is where "confirm the implementation details" happens;
5. a closing line asking for a go-ahead.

Then ask for the decision through ask_user_question in the same turn: options
"Approve and execute" (recommended, first), "I want to change the plan", and
"Stop for now". Keep the plan in your message text, not only inside the
question.

After approval, execute exactly that plan. If the user amends it, restate only
the amended part and continue; do not re-open settled points. If the user
answers with something that approves nothing specific ("随便", "都行", "你看着
办"), treat it as "no approval yet": name the option you will take and get
confirmation, because the result is user-visible.

Never treat silence, an unrelated new request, or approval of a different plan
as approval of this one.

Apply the same gate to every later user message for the whole session,
including short follow-ups ("继续", "好的", "改一下"): re-analyze them in
context and ask again when they are ambiguous about which task, scope, or
desired change they refer to. A follow-up that continues an already approved
plan is not a new plan — act on it. Requirements already confirmed are settled;
do not ask about them again.

If executing reveals that an earlier answer or assumption is wrong or
incomplete, stop and ask rather than silently re-planning around it.`

/**
 * Subagent exception appended to the effective protocol.
 *
 * A forked subagent inherits its parent's log prefix, so an enabled mode
 * reaches the child as an active projection and this section enters the
 * child's prompt. A delegated child cannot ask a human, though: its
 * `ask_user_question` is refused with `DELEGATED_CALLER`, so the section must
 * degrade to "report the question in your final result" instead of asking.
 */
export const SUBAGENT_NOTE = `## Subagent exception

If your system prompt contains a delegated/subagent section, you are running as a subagent: do not call ask_user_question, because human interaction is unavailable to a delegated agent and the tool returns DELEGATED_CALLER. Put the blocking question, the plausible options (recommended first), and your proposed repair into your final result instead, so the delegating agent can ask the user.`

/** Marker that identifies an author-supplied subagent exception in a custom `section`. */
const SUBAGENT_MARKER = 'DELEGATED_CALLER'

/** Upper bound on the model-facing protocol text (default text plus any override). */
const MAX_SECTION_LENGTH = 20_000

/** Config keys this row accepts. */
const CONFIG_KEYS = ['section', 'appendSubagentNote']

/**
 * Validate one plugin row config and resolve the effective protocol text.
 *
 * The subagent exception is appended to the default text and to any custom
 * `section`, so overriding the protocol never silently re-enables
 * `ask_user_question` inside a delegated child. An author who already wrote
 * the exception into `section` (it names `DELEGATED_CALLER`) is left alone.
 *
 * @param config raw row config.
 * @returns the effective protocol text and the resolved option values.
 * @throws {TypeError} when `section` or `appendSubagentNote` has the wrong type.
 * @throws {Error} when the config carries unknown keys.
 * @throws {RangeError} when the effective protocol text exceeds {@link MAX_SECTION_LENGTH}.
 */
export function resolveGrillConfig(config) {
  const raw = isRecord(config) ? config : {}
  const unknown = Object.keys(raw).filter(key => !CONFIG_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new Error(`grill: unknown config key(s) ${unknown.join(', ')} — config is { section, appendSubagentNote }`)
  }
  const section = raw.section
  if (section !== undefined && typeof section !== 'string') {
    throw new TypeError('grill: config.section must be a string')
  }
  if (typeof section === 'string' && section.length > MAX_SECTION_LENGTH) {
    throw new RangeError(`grill: config.section must be at most ${MAX_SECTION_LENGTH} characters, got ${section.length}`)
  }
  const appendSubagentNote = raw.appendSubagentNote
  if (appendSubagentNote !== undefined && typeof appendSubagentNote !== 'boolean') {
    throw new TypeError('grill: config.appendSubagentNote must be a boolean')
  }
  const base = typeof section === 'string' && section.trim() !== '' ? section : DEFAULT_SECTION
  const text = appendSubagentNote === false || base.includes(SUBAGENT_MARKER)
    ? base
    : `${base}\n\n${SUBAGENT_NOTE}`
  if (text.length > MAX_SECTION_LENGTH) {
    throw new RangeError(`grill: effective protocol text must be at most ${MAX_SECTION_LENGTH} characters, got ${text.length}`)
  }
  return { section: text, appendSubagentNote: appendSubagentNote !== false }
}

/** Stable wire views: identity-stable per active flag so unchanged states never publish. */
const VIEW_ON = Object.freeze({ active: true })
const VIEW_OFF = Object.freeze({ active: false })

/** Projection key shared by the host unit and the client switch. */
export const GRILL_KEY = 'grill'

/** Command name (without the leading slash). */
export const GRILL_COMMAND = 'grill'

/**
 * Parse the command's free-form argument.
 * @param value raw command input (the registry includes separator whitespace).
 * @returns the requested state, or undefined for an unrecognized argument.
 */
export function parseGrillArgument(value) {
  const arg = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (arg === '' || arg === 'on' || arg === '1' || arg === 'true') return true
  if (arg === 'off' || arg === '0' || arg === 'false') return false
  return undefined
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one folded state; only `parse` is used by the projection registry. */
const stateSchema = {
  parse(value) {
    if (!isRecord(value)) throw new Error('grill: projection state must be an object')
    if (typeof value.active !== 'boolean') throw new Error('grill: projection state.active must be a boolean')
    if (value.running === null || value.running === undefined) return { active: value.active, running: null }
    if (!isRecord(value.running)
      || typeof value.running.commandId !== 'string'
      || typeof value.running.wanted !== 'boolean') {
      throw new Error('grill: projection state.running must be { commandId, wanted } or null')
    }
    return { active: value.active, running: { commandId: value.running.commandId, wanted: value.running.wanted } }
  },
}

/** Validate one published view. */
const viewSchema = {
  parse(value) {
    if (!isRecord(value) || typeof value.active !== 'boolean') {
      throw new Error('grill: view must be { active: boolean }')
    }
    return { active: value.active }
  },
}

/**
 * Log-derived 拷问 state: the last settled `/grill` command wins.
 *
 * A command only changes the state when its paired `command/done` reports
 * success, so an invalid or failed toggle leaves the mode untouched.
 */
export const grillProjection = {
  key: GRILL_KEY,
  stateVersion: 1,
  stateSchema,
  init: () => ({ active: false, running: null }),
  apply(state, event) {
    if (event.type === 'command/run' && event.data.name === GRILL_COMMAND) {
      const wanted = parseGrillArgument(event.data.args)
      if (wanted === undefined) return state
      return { ...state, running: { commandId: event.data.commandId, wanted } }
    }
    if (event.type === 'command/done') {
      const running = state.running
      if (running === null || event.data.commandId !== running.commandId) return state
      const active = event.data.kind === 'success' ? running.wanted : state.active
      return { active, running: null }
    }
    return state
  },
  wire: {
    viewSchema,
    // The view is a constant per flag, so the registry's Object.is comparison
    // suppresses publication for unrelated events.
    view: state => (state.active ? VIEW_ON : VIEW_OFF),
    // This key is deliberately absent from a Session summary (the sidebar list):
    // `summary: false` is the runtime half of the `SessionProjectionSummaryExcluded`
    // mark a typed consumer would carry on this key in `SessionProjectionMap`.
    // Keep the two in agreement if a type declaration for this key is ever added.
    summary: false,
  },
}

/** Required services: prompt contributions and the per-Session projection table. */
export const inject = ['systemPrompt', 'sessionProjections']

/**
 * Mount the 拷问 projection, prompt section and `/grill` command.
 * @param ctx plugin context.
 * @param config optional row config: `{ section?: string, appendSubagentNote?: boolean }`.
 *   `section` replaces the default protocol; `appendSubagentNote` (default true)
 *   keeps the subagent exception appended to either text.
 * @returns a promise settling once the projection is registered and consumers are published.
 * @throws when the row config is invalid (see {@link resolveGrillConfig}).
 */
export async function apply(ctx, config) {
  const sectionText = resolveGrillConfig(config).section

  // The command is independent of the projection handle, so register it first;
  // the child fiber activates only when a command registry is composed.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: GRILL_COMMAND,
      description: 'Interrogation mode on for this conversation (/grill [on|off]): analyze every request for ambiguity, gaps and contradictions and ask before acting',
      input: { hint: '[on|off]' },
      handler: ({ rawInput }) => {
        const wanted = parseGrillArgument(rawInput)
        if (wanted === undefined) return { kind: 'error', text: 'Usage: /grill [on|off]' }
        return {
          kind: 'success',
          text: wanted
            ? 'Interrogation mode on. Every request is analyzed for ambiguity, missing information and contradictions; the agent asks focused questions with concrete fixes before planning or executing.'
            : 'Interrogation mode off. Requests are handled normally again.',
        }
      },
    })
  })

  // Consumers must not publish before the unit is ready: the prompt section
  // reads the folded state on every assembly.
  const handle = await ctx.sessionProjections.register(grillProjection)
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'grill:policy',
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY') + 10,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return ''
      return handle.stateOf(agent.session).active ? sectionText : ''
    },
  }), 'grill: prompt section')
}
