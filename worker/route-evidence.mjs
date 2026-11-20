// Recognize one literal Orca invocation. Never evaluate shell syntax or search other
// commands, quoted prose or a tool's output for an embedded invocation.
const term = /^term_[\da-z-]{1,128}$/i
const msg = /^msg_[\da-z-]{1,128}$/i
const dispatch = /^ctx_[\da-z-]{1,128}$/i
const switches = new Set(['--json', '--full', '--keep-open', '--no-parent'])
const flagsFor = {
  'orchestration send':
    '--to --from --subject --body --body-file --type --priority --thread-id --task-id --dispatch-id --outcome --files-modified --report-path --phase --chat --item --json --full',
  'orchestration reply': '--from --id --body --body-file --json --full',
  'orchestration ask': '--from --question --json',
  'orchestration check': '--terminal --run --json --full',
  'orchestration worker-start':
    '--from --terminal --agent --spec --spec-file --task --task-title --model --effort --worktree --repo --name --base-branch --json --keep-open',
  'agent launch': '--agent --worktree --surface --prompt --model --effort --json',
  'worktree create':
    '--name --repo --agent --prompt --model --effort --base-branch --parent-worktree --no-parent --setup --json'
}
const kept = new Set(['--to', '--from', '--terminal', '--surface', '--id', '--run'])
// Match only the executable word. Never expand variables or accept shell wrappers.
const executable = /^(?:orca|"\$ORCA_CLI_BIN_DIR\/orca")(?=[ \t])/

export function actionOf(event) {
  if (!['Bash', 'Shell', 'exec_command'].includes(event.tool)) return
  const command = event.input?.command ?? event.input?.cmd
  if (typeof command !== 'string' || command.length > 65536) return
  const prefix = executable.exec(command)
  if (!prefix) return
  const words = []
  // Unquoted metacharacters, substitutions, redirection and compound commands
  // are outside this grammar. Quoted option values stay a single word.
  const word = /(?:[\w./:@%+=,-]+|'[^']*'|"[^"\\$`]*")+/gy
  for (let index = prefix[0].length; index < command.length;) {
    if (command[index] === ' ' || command[index] === '\t') {
      index++
      continue
    }
    word.lastIndex = index
    const match = word.exec(command)
    if (!match) return
    words.push(match[0].replace(/'([^']*)'|"([^"]*)"/g, (_, a, b) => a ?? b))
    if (words.length > 128) return
    index = word.lastIndex
  }
  const [group, verb, ...args] = words
  const allowed = flagsFor[group + ' ' + verb]?.split(' ')
  if (!allowed) return
  const flags = new Map()
  for (let i = 0; i < args.length; i++) {
    const name = args[i]
    if (!allowed.includes(name) || flags.has(name)) return
    if (switches.has(name)) flags.set(name, true)
    else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      const value = args[++i]
      flags.set(name, kept.has(name) ? value : true)
    } else return
  }
  const target = flags.get('--to')
  if (target?.length > 256) return
  if (
    target &&
    !(term.test(target) || /^(?:bot|dispatch|run|orca_session_id):[^\s]+$/.test(target))
  )
    return
  if (flags.has('--from') && flags.get('--from') !== event.terminalId) return
  if (verb === 'check' && flags.has('--terminal') && flags.get('--terminal') !== event.terminalId)
    return
  if (flags.get('--surface') === 'chat' || (verb === 'create' && !flags.has('--agent'))) return
  if (flags.has('--terminal') && !term.test(flags.get('--terminal'))) return
  const run = flags.get('--run')
  if (flags.has('--run') && (!flags.has('--terminal') || !/^run_[\da-f-]{1,128}$/i.test(run)))
    return
  const replyTo = flags.get('--id')
  if (verb === 'reply' && !msg.test(replyTo)) return
  if (verb === 'ask' && !flags.has('--question')) return
  return {
    verb,
    replyTo,
    run,
    target,
    attached: flags.get('--terminal'),
    json: flags.has('--json'),
    full: flags.has('--full')
  }
}

export function receiptOf(action, event) {
  const output = event.output?.stdout ?? event.output
  if (typeof output !== 'string' || output.length > 262144 || event.output?.is_error) return
  if (!action.json) {
    if (action.verb === 'send' || action.verb === 'reply') {
      const id = /^messageId=(msg_[\da-z-]{1,128})(?=\s|$)/i.exec(output)?.[1]
      if (id && id !== action.replyTo) return { id }
    }
    if (action.verb === 'check' && !action.full) {
      const id = /^(msg_[\da-z-]{1,128}) [a-z_]+ from \S+/.exec(output)?.[1]
      if (id) return { received: [id] }
    }
    return
  }
  let response
  try {
    response = JSON.parse(output)
  } catch {
    return
  }
  if (response?.ok !== true || !response.result) return
  const r = response.result
  if (action.verb === 'check') {
    if (
      !Array.isArray(r.messages) ||
      r.cancelled ||
      r.connectionLost ||
      r.legacyCompatibility?.readOnly ||
      r.legacyCompatibility?.recovery
    )
      return
    return {
      received: r.messages
        .slice(0, 200)
        .map((row) => row?.id)
        .filter((id) => typeof id === 'string' && msg.test(id))
    }
  }
  if (
    action.verb === 'send' ||
    action.verb === 'reply' ||
    (action.verb === 'ask' && r.pending === true)
  ) {
    const id = r.messageId ?? r.message?.id
    if (typeof id === 'string' && msg.test(id) && id !== action.replyTo) return { id }
  }
  if (action.verb === 'launch' || action.verb === 'create') {
    const outcome = action.verb === 'create' ? r.launch?.outcome : r.outcome
    if (
      outcome?.kind === 'terminal' &&
      typeof outcome.handle === 'string' &&
      term.test(outcome.handle)
    )
      return { terminal: outcome.handle }
  }
  if (
    action.verb === 'worker-start' &&
    r.state === 'ready' &&
    (r.mode === undefined || r.mode === 'terminal') &&
    typeof r.terminal === 'string' &&
    term.test(r.terminal) &&
    typeof r.dispatchId === 'string' &&
    dispatch.test(r.dispatchId)
  ) {
    return { terminal: r.terminal, dispatch: 'dispatch:' + r.dispatchId }
  }
}

const LIMIT = 512
const TTL = 120000
function remember(map, key, value) {
  if (map.size >= LIMIT && !map.has(key)) map.delete(map.keys().next().value)
  map.set(key, value)
}

// Only short-lived routing facts survive a hook callback. A mailbox name is never
// joined to a title. A receiver checking its own mailbox can confirm the exact ID.
export class RouteEvidence {
  calls = new Map()
  sequence = 0
  accepted = new Map()
  received = new Map()
  launches = new Map()
  dispatches = new Map()

  constructor(store, owner, now = Date.now) {
    this.store = store
    this.owner = owner
    this.now = now
  }

  observe(phase, event) {
    const action = actionOf(event)
    if (!action || !event.callId || !term.test(event.terminalId)) return
    const source = this.owner(event.terminalId)
    if (!source || source.provider !== event.agent) return
    const key = JSON.stringify([event.terminalId, event.callId])
    if (phase === 'before') {
      const prior = this.calls.get(key)
      if (prior) {
        prior.ambiguous = true
        return
      }
      let target
      if (term.test(action.target)) target = this.owner(action.target)
      else {
        const alias = this.dispatches.get(action.target)
        if (alias && this.owner(alias.terminal) === alias) target = alias
      }
      if (action.verb === 'worker-start' && action.attached) target = this.owner(action.attached)
      remember(this.calls, key, { action, source, target, at: this.now(), seq: ++this.sequence })
      return
    }
    const call = this.calls.get(key)
    if (call?.ambiguous) return
    this.calls.delete(key)
    if (
      !call ||
      call.source !== source ||
      this.now() - call.at > TTL ||
      JSON.stringify(call.action) !== JSON.stringify(action)
    )
      return
    const receipt = receiptOf(action, event)
    if (!receipt) return
    if (receipt.terminal) {
      if (
        action.attached &&
        (receipt.terminal !== action.attached ||
          !call.target ||
          this.owner(action.attached) !== call.target)
      )
        return
      remember(this.launches, receipt.terminal, {
        ...receipt,
        source,
        at: this.now(),
        start: call.at,
        attached: action.attached
      })
      this.bindLaunch(receipt.terminal)
    } else if (receipt.received) {
      for (const id of receipt.received) {
        remember(this.received, id, { source, at: this.now() })
        this.confirm(id)
      }
    } else {
      const { target } = call
      if (target && this.owner(target.terminal) !== target) return
      // A direct terminal can be cleared while mail waits. Its check must still
      // belong to the same observed session before it can upgrade this arrow.
      if (term.test(action.target) && !target) return
      if (this.excludeConflictingSender(receipt.id, source)) return
      const prior = this.accepted.get(receipt.id)
      if (prior) {
        if (prior.target?.id !== target?.id) prior.ambiguous = true
        return
      }
      const send = { source, target, at: this.now() }
      remember(this.accepted, receipt.id, send)
      if (target && !this.received.has(receipt.id)) this.message(receipt.id, send, target)
      this.confirm(receipt.id)
    }
  }

  excludeConflictingSender(id, source) {
    const key = 'public-mail:' + id
    const recorded = this.store.messages.get(key)
    const pending = this.accepted.get(id)
    if (!recorded?.senderConflict) {
      if (
        (!recorded?.from || recorded.from === source.id) &&
        (!pending || pending.source.id === source.id)
      )
        return false
      this.store.message({ id: key, senderConflict: true, at: this.now() })
    }
    this.accepted.delete(id)
    return true
  }

  reconcileRestoredSenders() {
    for (const [id, send] of this.accepted) this.excludeConflictingSender(id, send.source)
  }

  message(id, send, target, deliveredAt) {
    const key = 'public-mail:' + id
    const old = this.store.messages.get(key)
    if (
      old &&
      (old.to !== target.id || (old.from && (old.from !== send.source.id || old.deliveredAt)))
    )
      return
    this.store.message({
      id: key,
      from: send.source.id,
      to: target.id,
      at: old?.from ? old.at : send.at,
      type: deliveredAt ? 'Mailbox received' : 'Send accepted',
      ...(deliveredAt && { deliveredAt })
    })
  }

  confirm(id) {
    const send = this.accepted.get(id)
    const check = this.received.get(id)
    if (!check) return
    if (!send || send.ambiguous) {
      const old = this.store.messages.get('public-mail:' + id)
      if (!old || old.senderConflict) {
        this.store.message({
          id: 'public-mail:' + id,
          from: null,
          to: check.source.id,
          at: check.at,
          deliveredAt: check.at,
          type: 'Mailbox input'
        })
      } else if (!send && !old.deliveredAt && old.to === check.source.id) {
        old.deliveredAt = check.at
        old.type = 'Mailbox received'
        this.received.delete(id)
      }
      return
    }
    if (Math.abs(check.at - send.at) > TTL || (send.target && send.target !== check.source)) return
    this.message(id, send, check.source, check.at)
    this.accepted.delete(id)
    this.received.delete(id)
  }

  bindLaunch(terminal) {
    const launch = this.launches.get(terminal)
    if (!launch) return
    const child = this.owner(terminal)
    if (!child) return
    if (
      (launch.child && launch.child !== child) ||
      this.now() - launch.at > TTL ||
      child.id === launch.source.id
    ) {
      this.launches.delete(terminal)
      return
    }
    launch.child = child
    if (!launch.attached && (!child.first || child.since < launch.start)) {
      this.launches.delete(terminal)
      return
    }
    if (launch.dispatch) remember(this.dispatches, launch.dispatch, child)
    if (!launch.attached) {
      const createdAt = this.store.agents.get(child.id)?.createdAt
      if (!Number.isFinite(createdAt)) return
      if (createdAt >= launch.start)
        this.store.agent(child.id, { parentId: launch.source.id, spawnedAt: launch.at })
    }
    this.launches.delete(terminal)
  }

  attempts() {
    const attempts = []
    for (const { action, source, target, at, seq, ambiguous } of this.calls.values()) {
      if (
        !ambiguous &&
        action.verb === 'send' &&
        target &&
        this.now() - at <= TTL &&
        this.owner(target.terminal) === target &&
        this.owner(source.terminal) === source
      ) {
        attempts.push({
          id: 'public-attempt:' + seq,
          at,
          from: source.id,
          to: target.id,
          type: 'Send attempted'
        })
      }
    }
    return attempts
  }

  refresh() {
    const cutoff = this.now() - TTL
    for (const cache of [this.calls, this.accepted, this.received, this.launches]) {
      for (const [key, row] of cache) if (row.at < cutoff) cache.delete(key)
    }
    for (const terminal of this.launches.keys()) this.bindLaunch(terminal)
    for (const [key, owner] of this.dispatches)
      if (this.owner(owner.terminal) !== owner) this.dispatches.delete(key)
  }
}
