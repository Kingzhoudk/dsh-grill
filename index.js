/**
 * 拷问 (Grill) mode — host half.
 *
 * The mode is per-Session collaboration state derived from the session log: a
 * `/grill on` / `/grill off` command is folded by the `grill` projection unit,
 * and while the state is active the `grill:policy` prompt section is included
 * in every model request of that Session. The switch in the composer is only
 * the surface for the same command, so the mode works in every environment that
 * has a command registry — a terminal, an ACP/SDK client, an IM relay or a
 * headless run — even where no composer switch exists.
 *
 * No custom session event type is introduced: the fold reads the existing
 * `command/run` / `command/done` pair, so resume, fork and replay restore the
 * mode from what is already durable.
 *
 * Two environment adaptations sit on top of the log-derived state:
 *   - `defaultActive` starts every Session in the requested state, which is the
 *     only way to select the mode in a one-shot environment (headless task,
 *     scheduled prompt) where nobody can type a command first;
 *   - a spawned subagent inherits an active parent, because its fresh log holds
 *     no `/grill` command of its own; a forked child already inherits the
 *     parent's event prefix and needs no extra bookkeeping.
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

If a plan-mode policy section is present in this system prompt, that policy owns
the plan-and-stop mechanism: keep this gate's analysis and questions, carry this
gate's plan requirements (file paths, before/after, verification, risks) into
the plan you submit through it, and ask for approval once — not twice.

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

/**
 * Environment exception appended to the effective protocol.
 *
 * Interrogation mode assumes a human can answer. That is false in a headless
 * run, an ACP/SDK client, a scheduled prompt, an IM relay without question
 * support, or any preset that omits `ask_user_question`; there the question
 * tool reports `NO_PROVIDER` (or is absent) and a blocking gate that insists on
 * asking would either stall or loop on a failing tool. The fallback keeps the
 * analysis valuable: write the questions down, act on the recommendation when
 * the step is reversible, and stop only before something irreversible.
 */
export const NO_HUMAN_NOTE = `## Environment fallback: when no human can answer

ask_user_question is not always answerable. A headless one-shot run, an ACP or SDK client, a scheduled task, an IM relay without question support, or a preset that omits the tool rejects it with NO_PROVIDER (or the tool is missing from your catalog entirely), and a delegated child receives DELEGATED_CALLER. When that happens, never retry the same call and never wait for an answer that cannot arrive. Fall back to the written gate:
1. put each blocking finding, the exact question, the options with your recommendation and the repair you would apply into your answer;
2. TRIVIAL work and reversible NON-TRIVIAL work: continue on the recommended option and label it as an assumption the user can overturn;
3. an irreversible step, or a decision only the user can own: stop before the state-changing call and hand back the plan plus the open questions, so the next message can approve them.`

/** Marker that identifies an author-supplied subagent exception in a custom `section`. */
const SUBAGENT_MARKER = 'DELEGATED_CALLER'

/** Marker that identifies an author-supplied environment exception in a custom `section`. */
const NO_HUMAN_MARKER = 'NO_PROVIDER'

/** Upper bound on the model-facing protocol text (default text plus any override). */
const MAX_SECTION_LENGTH = 20_000

/** Config keys this row accepts. */
const CONFIG_KEYS = ['section', 'appendSubagentNote', 'appendEnvironmentNote', 'defaultActive']

/**
 * Validate one plugin row config and resolve the effective protocol text.
 *
 * The subagent exception is appended to the default text and to any custom
 * `section`, so overriding the protocol never silently re-enables
 * `ask_user_question` inside a delegated child. An author who already wrote
 * the exception into `section` (it names `DELEGATED_CALLER`) is left alone.
 * The environment exception follows the same rule and is detected by
 * `NO_PROVIDER`.
 *
 * @param config raw row config.
 * @returns the effective protocol text and the resolved option values.
 * @throws {TypeError} when a typed key has the wrong type.
 * @throws {Error} when the config carries unknown keys.
 * @throws {RangeError} when the effective protocol text exceeds {@link MAX_SECTION_LENGTH}.
 */
export function resolveGrillConfig(config) {
  const raw = isRecord(config) ? config : {}
  const unknown = Object.keys(raw).filter(key => !CONFIG_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new Error(`grill: unknown config key(s) ${unknown.join(', ')} — config is { section, appendSubagentNote, appendEnvironmentNote, defaultActive }`)
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
  const appendEnvironmentNote = raw.appendEnvironmentNote
  if (appendEnvironmentNote !== undefined && typeof appendEnvironmentNote !== 'boolean') {
    throw new TypeError('grill: config.appendEnvironmentNote must be a boolean')
  }
  const defaultActive = raw.defaultActive
  if (defaultActive !== undefined && typeof defaultActive !== 'boolean') {
    throw new TypeError('grill: config.defaultActive must be a boolean')
  }
  let text = typeof section === 'string' && section.trim() !== '' ? section : DEFAULT_SECTION
  if (appendSubagentNote !== false && !text.includes(SUBAGENT_MARKER)) {
    text = `${text}\n\n${SUBAGENT_NOTE}`
  }
  if (appendEnvironmentNote !== false && !text.includes(NO_HUMAN_MARKER)) {
    text = `${text}\n\n${NO_HUMAN_NOTE}`
  }
  if (text.length > MAX_SECTION_LENGTH) {
    throw new RangeError(`grill: effective protocol text must be at most ${MAX_SECTION_LENGTH} characters, got ${text.length}`)
  }
  return {
    section: text,
    appendSubagentNote: appendSubagentNote !== false,
    appendEnvironmentNote: appendEnvironmentNote !== false,
    defaultActive: defaultActive === true,
  }
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

/**
 * Resolve one command argument against the state it is applied to.
 *
 * `/grill toggle` is relative, so the fold must be able to replay it without
 * consulting the world: the target is derived from the state the fold already
 * holds. Resolving it only in the command handler would record `toggle` in the
 * log while the fold silently ignored it, so the switch would appear to work in
 * this process and revert after a restart.
 *
 * @param value raw command input.
 * @param currentActive state the argument applies to.
 * @returns the requested state, or undefined for an unrecognized argument.
 */
export function resolveGrillTarget(value, currentActive) {
  const arg = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (arg === 'toggle') return currentActive !== true
  return parseGrillArgument(value)
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
 *
 * @param options.defaultActive state for a Session whose log carries no settled
 *   `/grill` command; the configured row uses it to preselect the mode in
 *   environments where nobody can type a command first.
 * @returns one projection definition.
 */
export function createGrillProjection({ defaultActive = false } = {}) {
  const initial = defaultActive === true
  return {
    key: GRILL_KEY,
    stateVersion: 1,
    stateSchema,
    init: () => ({ active: initial, running: null }),
    apply(state, event) {
      if (event.type === 'command/run' && event.data.name === GRILL_COMMAND) {
        const wanted = resolveGrillTarget(event.data.args, state.active)
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
}

/** Default projection instance (mode off until a command says otherwise). */
export const grillProjection = createGrillProjection()

/**
 * Effective mode state for one Session.
 *
 * The folded projection is the durable source. Two additions sit beside it:
 * an explicit toggle recorded before the fold catches up, and the inherited-on
 * set that carries an active parent into a spawned subagent whose own log holds
 * no `/grill` event.
 *
 * Kept free of Cordis so the inheritance and override rules can be exercised
 * directly; {@link apply} binds the projection handle into it.
 *
 * @param options.defaultActive fallback for a Session with no folded state.
 * @returns the state view used by the command, the prompt section and the gate.
 */
export function createGrillView({ defaultActive = false } = {}) {
  /** Sessions whose active parent handed the mode down; no durable event of their own. */
  const inherited = new Set()
  /** State remembered by a just-run command, cleared once the fold agrees. */
  const overrides = new Map()
  let folded = () => undefined

  return {
    /** Attach the projection read; a throwing or absent handle reads as unknown. */
    bind(read) {
      folded = typeof read === 'function' ? read : () => undefined
    },
    /** Whether interrogation mode governs this Session. */
    isActive(session) {
      if (!session) return false
      const id = session.id
      let state
      try {
        state = folded(session)
      } catch {
        state = undefined
      }
      const durable = state !== undefined && typeof state.active === 'boolean' ? state.active : undefined
      if (overrides.has(id)) {
        const wanted = overrides.get(id)
        if (durable === wanted) overrides.delete(id)
        else return wanted
      }
      if (inherited.has(id)) return true
      if (durable !== undefined) return durable
      return defaultActive === true
    },
    /** Record a just-run toggle before its `command/done` reaches the fold. */
    remember(session, active) {
      if (!session) return
      overrides.set(session.id, active === true)
      // An explicit choice always outranks inheritance in both directions: a
      // child that inherited ON and is then turned OFF must stay off once the
      // fold agrees, instead of falling back to the inherited value.
      inherited.delete(session.id)
    },
    /** Mark a Session as inheriting an active parent. */
    inherit(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      inherited.add(sessionId)
    },
    /** Release per-Session bookkeeping when the Session goes away. */
    forget(sessionId) {
      if (typeof sessionId !== 'string') return
      inherited.delete(sessionId)
      overrides.delete(sessionId)
    },
  }
}

/** Required services: prompt contributions and the per-Session projection table. */
export const inject = ['systemPrompt', 'sessionProjections']

/**
 * Mount the 拷问 projection, prompt section and `/grill` command.
 * @param ctx plugin context.
 * @param config optional row config: `{ section?, appendSubagentNote?,
 *   appendEnvironmentNote?, defaultActive? }`. `section` replaces the default
 *   protocol; the two append flags keep the subagent and no-human exceptions
 *   attached to either text; `defaultActive` starts every Session active.
 * @returns a promise settling once the projection is registered and consumers are published.
 * @throws when the row config is invalid (see {@link resolveGrillConfig}).
 */
export async function apply(ctx, config) {
  const resolved = resolveGrillConfig(config)
  const sectionText = resolved.section
  const view = createGrillView({ defaultActive: resolved.defaultActive })

  /**
   * Read an inactive parent's state for a spawned subagent.
   *
   * A live parent answers from its own agent; a parent that is not live in this
   * process (resumed elsewhere, or a restart between spawn and creation) is
   * read from its durable projection, so inheritance survives a restart.
   *
   * @param parentId durable parent session id.
   * @returns true when the parent has interrogation mode on, undefined when unknown.
   */
  async function parentIsActive(parentId) {
    const sessions = ctx.get?.('sessions')
    const parent = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(parentId) : undefined
    if (parent !== undefined) return view.isActive(parent)
    const query = ctx.get?.('sessionQuery')
    if (query === undefined || typeof query.observeSession !== 'function') return undefined
    let observation
    try {
      observation = await query.observeSession(parentId, { projectionMode: 'all' })
      const value = observation?.projections?.values?.[GRILL_KEY]
      if (value !== undefined && typeof value.active === 'boolean') return value.active === true
      return undefined
    } catch {
      return undefined
    } finally {
      try {
        observation?.[Symbol.dispose]?.()
      } catch {
        /* ignore */
      }
    }
  }

  // The command is independent of the projection handle, so register it first;
  // the child fiber activates only when a command registry is composed.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: GRILL_COMMAND,
      description: 'Interrogation mode on or off for this conversation (/grill [on|off|status|toggle]): analyze every request for ambiguity, gaps and contradictions and ask before acting',
      input: { hint: '[on|off|status|toggle]' },
      handler: ({ agent, rawInput }) => {
        const active = view.isActive(agent?.session)
        const arg = typeof rawInput === 'string' ? rawInput.trim().toLowerCase() : ''
        if (arg === 'status') {
          return {
            kind: 'success',
            text: active
              ? 'Interrogation mode is ON for this conversation: every request is analyzed for ambiguity, missing information and contradictions before planning or execution.'
              : 'Interrogation mode is OFF for this conversation: requests are handled normally.',
          }
        }
        const wanted = resolveGrillTarget(rawInput, active)
        if (wanted === undefined) return { kind: 'error', text: 'Usage: /grill [on|off|status|toggle]' }
        view.remember(agent?.session, wanted)
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
  const handle = await ctx.sessionProjections.register(createGrillProjection({ defaultActive: resolved.defaultActive }))
  view.bind(session => handle.stateOf(session))

  // A spawned subagent's log is fresh, so it carries no `/grill` event of its
  // own; without inheritance an active parent would silently hand the task to a
  // child that no longer interrogates. A forked child inherits the parent's
  // event prefix and is already covered by the fold.
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    if (!agent?.session) return
    try {
      const id = agent.session.id
      if (view.isActive(agent.session)) return
      const parentId = agent.session.header?.parentSession
      if (typeof parentId !== 'string' || parentId === '') return
      void parentIsActive(parentId).then((parentActive) => {
        // An explicit choice made in this process always wins over inheritance.
        if (parentActive !== true) return
        if (view.isActive(agent.session)) return
        view.inherit(id)
      }, () => { /* unreadable parent: keep the child inactive */ })
    } catch {
      /* ignore: an unreadable header must not break agent creation */
    }
  }), 'grill: subagent inheritance')

  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    view.forget(agent?.session?.id)
  }), 'grill: state release')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'grill:policy',
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY') + 10,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return ''
      try {
        return view.isActive(agent.session) ? sectionText : ''
      } catch {
        return ''
      }
    },
  }), 'grill: prompt section')
}
