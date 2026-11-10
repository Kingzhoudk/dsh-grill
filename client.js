/**
 * 拷问 (Grill) mode — browser half.
 *
 * One compact switch in the composer tool row, registered through
 * `conversation.input.left` so it heads that group (the permission selector
 * and the plan chip render before the group, in the separate `modes` cluster).
 * The switch is a view of the host's log-derived `grill`
 * projection; clicking it executes `/grill on` / `/grill off`, and the
 * projection frame pushes the new state back. No client-side mode state is
 * kept, so a reload, resume or fork shows the same switch position.
 *
 * The bundle is plain JavaScript: React comes from the browser module table,
 * styles are component-owned CSS using only theme tokens, and no Harness
 * client package is imported.
 */
window.__ModuleLoader__.load({
  id: 'dsh-grill',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'grill'
    const PACKAGE_ID = 'dsh-grill'
    const SWITCH_ID = 'grill-switch'

    const EN = {
      'label': 'Grill',
      'aria.on': 'Interrogation mode is on; press to turn it off',
      'aria.off': 'Interrogation mode is off; press to turn it on',
      'title.on': 'Interrogation mode on — every request is analyzed and clarified before execution',
      'title.off': 'Interrogation mode off — press to make the agent analyze every request and clarify ambiguity, gaps and contradictions before acting',
      'title.busy': 'Switching interrogation mode…',
      'error.failed': 'Could not switch interrogation mode',
      'error.unavailable': 'This conversation cannot run the /grill command',
    }

    const ZH = {
      'label': '拷问',
      'aria.on': '拷问模式已开启，点击关闭',
      'aria.off': '拷问模式已关闭，点击开启',
      'title.on': '拷问模式已开启 — 每个请求都会先分析并澄清，再执行',
      'title.off': '拷问模式已关闭 — 点击后，每个请求都会先分析并澄清模糊、缺失与矛盾，再执行',
      'title.busy': '正在切换拷问模式…',
      'error.failed': '切换拷问模式失败',
      'error.unavailable': '当前会话无法执行 /grill 命令',
    }

    // Component-owned stylesheet; only theme tokens participate so light and
    // dark switching, font scaling and theme overrides keep working. The
    // aria-checked-driven appearance follows the host Switch primitive's
    // convention, but the geometry is intentionally smaller (28x16 track, 12px
    // thumb) to match the 28px-high composer controls. Copied rather than
    // imported: client packages are not modules a plain-JS plugin may require.
    const CSS = `
@keyframes grill-spin { to { transform: rotate(360deg) } }
.dsh-grill-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
}
@media (hover: hover) {
  .dsh-grill-toggle:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
}
.dsh-grill-toggle:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dsh-grill-toggle:disabled { cursor: default; opacity: 0.6; }
.dsh-grill-toggle[aria-checked='true'] { color: var(--dsw-alias-brand-primary); }
.dsh-grill-toggle[data-error] { color: var(--dsw-alias-state-error-primary); }
.dsh-grill-label { pointer-events: none; }
.dsh-grill-track {
  box-sizing: border-box;
  position: relative;
  flex: 0 0 auto;
  width: 28px;
  height: 16px;
  padding: 2px;
  border-radius: 999px;
  background: var(--dsw-alias-border-l3);
  transition: background-color 120ms ease;
}
.dsh-grill-toggle[aria-checked='true'] .dsh-grill-track { background: var(--dsw-alias-brand-primary); }
.dsh-grill-thumb {
  display: block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground);
  transition: transform 120ms ease;
}
.dsh-grill-toggle[aria-checked='false'] .dsh-grill-thumb { background: var(--dsw-alias-switch-thumb); }
.dsh-grill-toggle[aria-checked='true'] .dsh-grill-thumb { transform: translateX(12px); }
@media (prefers-reduced-motion: reduce) {
  .dsh-grill-track, .dsh-grill-thumb { transition: none; }
}
`

    function failureText(t, result) {
      if (result !== undefined && result.ok === false) {
        const error = result.error
        const message = error !== undefined && typeof error.message === 'string' ? error.message : undefined
        const code = error !== undefined && typeof error.code === 'string' ? error.code : undefined
        if (message !== undefined) return code === undefined ? message : `${message} (${code})`
      }
      return t('error.failed')
    }

    function GrillToggle(props) {
      const { useProjection, useSession, useAccess, useRemoteAccess, sessionId } = props
      // Every seat is defensive: a throwing component blanks the slot entry,
      // so a missing optional prop degrades the switch instead of the composer.
      const t = typeof props.t === 'function' ? props.t : key => key
      const projection = typeof useProjection === 'function' ? useProjection('grill') : undefined
      const active = projection !== undefined && projection.active === true
      const removed = typeof useSession === 'function' && useSession(snapshot => snapshot.removed) === true
      // Executing a slash command is the `commands/execute` endpoint, not
      // `session/prompt`: in a shared Session a viewer may prompt the source but
      // must not execute slash commands. Ask the global endpoint seat first and
      // fall back to the Session seat only when the global one is unavailable —
      // never to `session/prompt`.
      const commandAllowed = typeof useRemoteAccess === 'function'
        ? useRemoteAccess('commands/execute')
        : typeof useAccess === 'function' ? useAccess('commands/execute') : undefined
      const commandDenied = commandAllowed === false
      const [pending, setPending] = React.useState(false)
      const [error, setError] = React.useState(null)
      const alive = React.useRef(true)
      // Latest Session identity for late settlement: a response that lands after
      // the user switched Sessions must not write into the new Session's switch.
      const currentSession = React.useRef(sessionId)

      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      React.useEffect(() => {
        currentSession.current = sessionId
        setPending(false)
        setError(null)
      }, [sessionId])

      const title = error !== null
        ? `${t('error.failed')}: ${error}`
        : pending ? t('title.busy') : t(active ? 'title.on' : 'title.off')

      const toggle = () => {
        if (pending || removed || commandDenied) return
        setPending(true)
        setError(null)
        const target = sessionId
        const line = active ? '/grill off' : '/grill on'
        let request
        try {
          request = ctx.remote.commands.execute(target, line, [])
        } catch (reason) {
          setPending(false)
          setError(reason instanceof Error ? reason.message : String(reason))
          return
        }
        const stale = () => !alive.current || currentSession.current !== target
        request
          .then((result) => {
            if (stale()) return
            if (result === undefined) {
              setError(t('error.unavailable'))
              return
            }
            if (result.ok !== true) {
              setError(failureText(t, result))
              return
            }
            // An admitted command reports `ok` even when its handler rejected the
            // invocation; the durable outcome carries the reason to show.
            const outcome = result.value === undefined ? undefined : result.value.result
            if (outcome === undefined) {
              setError(t('error.unavailable'))
              return
            }
            if (outcome.kind === 'error') {
              setError(typeof outcome.text === 'string' && outcome.text.trim() !== ''
                ? outcome.text
                : t('error.failed'))
            }
          }, (reason) => {
            if (stale()) return
            setError(reason instanceof Error ? reason.message : String(reason))
          })
          .then(() => { if (!stale()) setPending(false) })
      }

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style', 'data-plugin': PACKAGE_ID }, CSS),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': active,
            'aria-label': t(active ? 'aria.on' : 'aria.off'),
            title,
            disabled: pending || removed || commandDenied,
            className: 'dsh-grill-toggle',
            ...(error === null ? {} : { 'data-error': '' }),
            onMouseDown: (event) => { event.preventDefault() },
            onClick: toggle,
          },
          h('span', { className: 'dsh-grill-label', key: 'label' }, t('label')),
          h('span', { className: 'dsh-grill-track', key: 'track' }, h('span', { className: 'dsh-grill-thumb' })),
        ),
      )
    }

    let ctx
    function apply(pluginCtx) {
      ctx = pluginCtx

      pluginCtx.effect(() => pluginCtx.locale.register(NS, 'en', EN), 'grill: English dictionary')
      pluginCtx.effect(() => pluginCtx.locale.register(NS, 'zh', ZH), 'grill: Chinese dictionary')

      pluginCtx.slots.inject('conversation.input.left', () => pluginCtx.slots.register({
        name: 'conversation.input.left',
        id: SWITCH_ID,
        // Heads the left group: the permission selector and the plan chip
        // render before that group (own `modes` cluster), so order 10 only
        // decides this entry's position inside the group.
        order: 10,
        locale: NS,
      }, GrillToggle))
    }

    return {
      // `remote.commands` is the mounted Remote namespace service; `remote`
      // carries it through the traceable service proxy.
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply,
    }
  },
})
