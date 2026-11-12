import { isAbsolute } from 'node:path'

// Source-derived native contract: shared/agent-session/lifecycle/agent-session-resume.ts,
// agent-resume-argv.ts and rpc-contract/agent-session-params.ts (audited 2026-11-12).
// Only identity/metadata policy lives here; the execution host builds every command.
const sessionProviders = [
  'claude',
  'codebuddy',
  'codex',
  'qoder',
  'qoder-cn',
  'qwen-code',
  'gemini',
  'opencode',
  'opencode2',
  'pi',
  'mimo-code',
  'droid',
  'grok',
  'devin',
  'omp',
  'prime-agent',
  'copilot',
  'kimi',
  'muse',
  'zcode',
  'dsh',
  'jcode',
  'kiro',
  'hermes'
]
const providerKeys = new Map([
  ...sessionProviders.map((provider) => [provider, 'session_id']),
  ['cursor', 'conversation_id'],
  ['antigravity', 'conversation_id']
])

export const providerSessionKey = (provider) => providerKeys.get(provider)
export const fileResumeProvider = (provider) => provider === 'pi' || provider === 'prime-agent'

const safeText = (value, max) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value === value.trim() &&
  Buffer.byteLength(value, 'utf8') <= max &&
  [...value].every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)

export const recordedPath = (value) => safeText(value, 16 * 1024)
export const recordedCwd = (value) => recordedPath(value) && isAbsolute(value)
const effortLevel = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value)

export function validProviderSession(provider, session) {
  return Boolean(
    session &&
    typeof session === 'object' &&
    !Array.isArray(session) &&
    Object.hasOwn(session, 'key') &&
    Object.hasOwn(session, 'id') &&
    Object.keys(session).every((key) => ['key', 'id', 'transcriptPath', 'effort'].includes(key)) &&
    providerSessionKey(provider) &&
    session.key === providerSessionKey(provider) &&
    typeof session.id === 'string' &&
    session.id.length <= 512 &&
    safeText(session.id, 2048) &&
    !session.id.startsWith('-') &&
    (session.transcriptPath === undefined || recordedPath(session.transcriptPath)) &&
    (session.effort === undefined || effortLevel(session.effort)) &&
    (!fileResumeProvider(provider) || recordedCwd(session.transcriptPath))
  )
}

export function terminalProviderSession(target) {
  return {
    key: target.providerSessionKey,
    id: target.providerSessionId,
    ...Object.fromEntries(
      ['transcriptPath', 'effort']
        .filter((key) => Object.hasOwn(target, key))
        .map((key) => [key, target[key]])
    )
  }
}

// Copy only normalized status metadata, never hook payloads, args, env or prompts.
// Retain an invalid marker instead of silently discarding malformed location evidence.
export function recordedResumeMetadata(session) {
  return Object.fromEntries(
    ['transcriptPath', 'cwd', 'effort']
      .filter((key) => Object.hasOwn(session ?? {}, key))
      .map((key) => [
        key,
        (key === 'effort' ? effortLevel(session[key]) : recordedPath(session[key]))
          ? session[key]
          : null
      ])
  )
}
