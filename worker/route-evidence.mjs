// Recognize one literal Orca invocation. Never evaluate shell syntax or search other
// commands, quoted prose or a tool's output for an embedded invocation.
const term = /^term_[\da-z-]{1,128}$/i
const msg = /^msg_(?=[\da-z_-]{1,128}$)[\da-z-]+(?:_[\da-z-]+)*$/i
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
const kept = new Set([
  '--to',
  '--from',
  '--terminal',
  '--surface',
  '--id',
  '--run',
  '--environment'
])
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
  // The public CLI accepts global flags before, within or after the command path,
  // and --flag=value. Never resolve a saved environment name or an inherited alias.
  const path = []
  const flags = new Map()
  for (let i = 0; i < words.length; i++) {
    const argument = words[i]
    if (!argument.startsWith('--')) {
      path.push(argument)
      continue
    }
    const equals = argument.indexOf('=')
    const name = equals < 0 ? argument : argument.slice(0, equals)
    if (flags.has(name)) return
    if (switches.has(name)) {
      if (equals >= 0) return
      flags.set(name, true)
    } else if (equals >= 0 || (i + 1 < words.length && !words[i + 1].startsWith('--'))) {
      const value = equals < 0 ? words[++i] : argument.slice(equals + 1)
      flags.set(name, kept.has(name) ? value : true)
    } else return
  }
  const [, verb] = path
  const allowed = flagsFor[path.join(' ')]?.split(' ')
  if (!allowed || path.length !== 2) return
  for (const name of flags.keys()) if (name !== '--environment' && !allowed.includes(name)) return
  if (flags.has('--environment') && flags.get('--environment') !== 'local') return
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
    environment: flags.get('--environment'),
    replyTo,
    run,
    target,
    attached: flags.get('--terminal'),
    json: flags.has('--json'),
    full: flags.has('--full')
  }
}

// These are advisory lines emitted by the public CLI, never routing evidence.
// Match their complete grammar; arbitrary bracketed text cannot close a field.
function mailboxFooter(line, id) {
  if (typeof line !== 'string') return
  if (
    line.startsWith(`[Reply: orca orchestration reply --id ${id} `) &&
    /^\[Reply: orca orchestration reply --id \S+(?: --from [\w:./@-]+)? --body "\.\.\."\]$/.test(
      line
    )
  )
    return 'action'
  if (
    /^\[(?:For your information: there is nothing to answer|To start a new worker: orca orchestration worker-start --spec "\.\.\.")\]$/.test(
      line
    ) ||
    /^\[To give this worker more work: orca orchestration send --to dispatch:ctx_[\da-z-]{1,128} --subject "\.\.\." --body "\.\.\."\]$/i.test(
      line
    ) ||
    /^\[Its follow-up (ctx_[\da-z-]{1,128}) is running; to message it: orca orchestration send --to dispatch:\1 --subject "\.\.\." --body "\.\.\."\]$/i.test(
      line
    )
  )
    return 'action'
  const remote =
    /^\[To start more work on (.+): orca orchestration worker-start --on ("(?:[^"\\\r\n$`]|\\["\\$`])*"|[\w.:@/-]+) --spec "\.\.\."\]$/.exec(
      line
    )
  if (remote) {
    const server = remote[1]
    const quoted = /^[\w.:@/-]+$/.test(server)
      ? server
      : '"' + server.replace(/["\\$`]/g, '\\$&') + '"'
    if (remote[2] === quoted) return 'action'
  }
  const sender =
    /^\[To answer its sender: orca orchestration send --to (.+?)(?: --chat [\w:./@-]{1,256} --type question)? --subject "\.\.\." --body "\.\.\."\]$/.exec(
      line
    )
  if (sender && /^(?:[\w.:@/-]+|"(?:[^"\\\r\n$`]|\\["\\$`])*")$/.test(sender[1])) return 'action'
  if (
    /^\[This worker was started for item ([1-9]\d{0,15}), "[^\r\n]*" \((?:Planned|In progress|Waiting|Needs you|Done|Canceled)\)\. (?:Done means: [^\r\n]*[.!?] )?If this result changes the item, update it with orca bot item <cancel\|comment\|done\|set> \1\.\]$/.test(
      line
    )
  )
    return 'item'
}

function fullMailboxReceipt(output) {
  // --full selects the public CLI's tagged format: every field line (including
  // empty body lines) has a two-space prefix. Old raw-body output cannot prove
  // later headers; do not scan it as a batch or use its claimed sender identity.
  const header = /^(\S+)(?: \[(?:HIGH|URGENT)\])? \[[a-z_]+\] from=[\w:./@-]{1,256}$/
  const lines = output.replace(/\r\n/g, '\n').split('\n')
  const delivery = /^Delivery ([\w-]{1,256})$/.exec(lines[0])?.[1]
  let index = delivery ? 1 : 0
  const received = new Set()
  const seen = new Set()
  const result = () => (received.size ? { received: [...received] } : undefined)
  while (index < lines.length) {
    const id = header.exec(lines[index++])?.[1]
    if (!id || !msg.test(id)) return result()
    if (seen.has(id) || seen.size === 200) return
    seen.add(id)
    const fields = ['[subject]', '[body]', '[payload]']
    let lastField = -1
    let sawField = false
    while (index < lines.length && fields.includes(lines[index])) {
      const field = fields.indexOf(lines[index++])
      if (field <= lastField || (lastField === -1 && field !== 0)) return result()
      lastField = field
      sawField = true
      const start = index
      while (lines[index]?.startsWith('  ')) index++
      if (index === start) return result()
    }
    if (!sawField || mailboxFooter(lines[index], id) !== 'action') return result()
    index++
    if (mailboxFooter(lines[index], id) === 'item') index++
    const acknowledgment =
      delivery &&
      `This Orca version does not acknowledge batches automatically. After handling every message, rerun this check with --ack ${delivery}.`
    if (lines[index]?.startsWith('Next: ') || (acknowledgment && lines[index] === acknowledgment)) {
      received.add(id)
      return result() // The CLI's final advice is not another message, even if multiline.
    }
    if (index < lines.length && lines[index] !== '') {
      // A verified action footer closed the fields, but unfamiliar trailing
      // metadata makes this row uncertain. Skip that row, not its neighbors.
      while (index < lines.length && lines[index] !== '') index++
    } else received.add(id)
    while (lines[index] === '') index++
  }
  return result()
}

function readyWorker(receipt) {
  if (
    receipt.state === 'ready' &&
    (receipt.mode === undefined || receipt.mode === 'terminal') &&
    typeof receipt.terminal === 'string' &&
    term.test(receipt.terminal) &&
    typeof receipt.dispatchId === 'string' &&
    dispatch.test(receipt.dispatchId)
  )
    return { terminal: receipt.terminal, dispatch: 'dispatch:' + receipt.dispatchId }
}

function plainWorkerReceipt(output) {
  // The concise CLI header contains key=value fields. A quoted value or the
  // separate Next line cannot supply a routing field.
  const [header] = output.split(/\r?\n/, 1)
  if (!header.startsWith('dispatchId=')) return
  const pairs = [...header.matchAll(/(?:^| )([a-zA-Z][\w.]*)=("(?:[^"\\]|\\.)*"|[^"\s]+)/gy)]
  if (pairs.map(([pair]) => pair).join('') !== header) return
  const fields = Object.fromEntries(pairs.map(([, key, value]) => [key, value]))
  if (
    Object.keys(fields).length !== pairs.length ||
    fields.mode !== 'terminal' ||
    !/^task_[\da-z-]{1,128}$/i.test(fields.taskId)
  )
    return
  return readyWorker(fields)
}

export function receiptOf(action, event) {
  const output = event.output?.stdout ?? event.output
  if (typeof output !== 'string' || output.length > 262144 || event.output?.is_error) return
  if (!action.json) {
    if (action.verb === 'worker-start') return plainWorkerReceipt(output)
    if (action.verb === 'send' || action.verb === 'reply') {
      const id = /^messageId=(\S+)(?=\s|$)/.exec(output)?.[1]
      if (id && msg.test(id) && id !== action.replyTo) return { id }
    }
    if (action.verb === 'check') {
      if (action.full) return fullMailboxReceipt(output)
      // Concise/older raw-body formats are indistinguishable when body text
      // mimics another header. The first header alone has an unambiguous start.
      const id = /^(\S+) [a-z_]+ from [\w:./@-]{1,256}(?: \[(?:HIGH|URGENT)\])?(?:\r?\n|$)/.exec(
        output
      )?.[1]
      if (id && msg.test(id)) return { received: [id] }
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
  if (r.replayed || r.legacyCompatibility?.readOnly || r.legacyCompatibility?.recovery) return
  if (action.verb === 'check') {
    if (!Array.isArray(r.messages) || r.cancelled || r.connectionLost) return
    const received = r.messages
      .slice(0, 200)
      .filter(
        (row) => !row?.readOnly && !['audit_only', 'legacy_direct'].includes(row?.delivery_contract)
      )
      .map((row) => row?.id)
      .filter((id) => typeof id === 'string' && msg.test(id))
    if (new Set(received).size !== received.length) return
    return { received }
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
  if (action.verb === 'worker-start') return readyWorker(r)
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
        if (!this.received.has(id)) remember(this.received, id, { source, at: this.now() })
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

  pendingLaunchWorkspaces() {
    const workspaces = new Set()
    for (const launch of this.launches.values()) {
      if (launch.attached || !launch.child) continue
      const agent = this.store.agents.get(launch.child.id)
      if (agent?.workspace && !Number.isFinite(agent.createdAt)) workspaces.add(agent.workspace)
    }
    return workspaces
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
