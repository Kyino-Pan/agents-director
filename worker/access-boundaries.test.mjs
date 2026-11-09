import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSourceText, sourceFilePath } from './source-files.mjs'
import { runtimeEndpoint } from './runtime-endpoint.mjs'
import { createSessionTabClient } from './session-tab-client.mjs'
import { terminalCliSpec } from './terminal-cli-policy.mjs'
import { OrcaLogReader } from './orca-log-reader.mjs'
import { ActivityStore } from './activity-store.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'activity-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = join(root, 'data')
  await mkdir(data)
  return { root, data }
}

test('source reads reject traversal, sibling-prefix paths, non-files and oversized payloads', async (t) => {
  const { root, data } = await fixture(t)
  await mkdir(join(root, 'data-sibling'))
  const outside = join(root, 'data-sibling', 'secret.jsonl')
  await writeFile(outside, 'outside')
  await writeFile(join(data, 'ok'), 'inside')
  assert.equal(await readSourceText(join(data, 'ok'), [data], 10), 'inside')
  await assert.rejects(readSourceText(outside, [data], 10), /outside the permitted/)
  await assert.rejects(
    readSourceText(join(data, '../data-sibling/secret.jsonl'), [data], 10),
    /outside the permitted/
  )
  await mkdir(join(data, 'not-a-file'))
  assert.throws(() => sourceFilePath(join(data, 'not-a-file'), [data]), /regular file/)
  await assert.rejects(readSourceText(join(data, 'ok'), [data], 2), /bounded reader/)
})

test(
  'symlinked imported files cannot escape the selected directory',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { root, data } = await fixture(t)
    const secret = join(root, 'secret.jsonl')
    await writeFile(secret, 'outside')
    await symlink(secret, join(data, 'escape.jsonl'))
    await assert.rejects(
      readSourceText(join(data, 'escape.jsonl'), [data], 100),
      /outside the permitted/
    )
  }
)

test('imported transcript references cannot read another local directory', async (t) => {
  const { root, data } = await fixture(t)
  await mkdir(join(data, 'agent-hooks'))
  const transcript = join(root, 'session.jsonl')
  await writeFile(
    transcript,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: { type: 'task_started' }
    }) + '\n'
  )
  await writeFile(
    join(data, 'agent-hooks', 'last-status.json'),
    JSON.stringify({
      entries: {
        pane: { providerSession: { agent: 'codex', id: 'outside', transcriptPath: transcript } }
      }
    })
  )
  const store = new ActivityStore()
  const reader = new OrcaLogReader(store, [data])
  t.after(() => reader.close())
  await reader.scan()
  assert.equal(
    [...store.points.values()].some((point) => point.source === 'transcript'),
    false
  )
  assert.match(store.sources.get(transcript).detail, /outside the permitted/)
})

test('runtime credentials cannot be sent to TCP objects, remote pipes or a different socket', () => {
  const metadata = { pid: 42, runtimeId: 'test-runtime', authToken: 'x'.repeat(32) }
  const directory = '/orca'
  const unix = { kind: 'unix', endpoint: join(directory, 'o-42-test.sock') }
  assert.equal(
    runtimeEndpoint({ ...metadata, transports: [unix] }, directory, 'linux'),
    unix.endpoint
  )
  for (const endpoint of [
    { host: 'example.com', port: 443 },
    'ws://example.com',
    '/elsewhere/o-42-test.sock',
    '/orca/o-99-test.sock'
  ]) {
    assert.throws(
      () =>
        runtimeEndpoint(
          { ...metadata, transports: [{ kind: 'unix', endpoint }] },
          directory,
          'linux'
        ),
      /local runtime socket/
    )
  }
  const pipe = '\\\\.\\pipe\\orca-42-test'
  assert.equal(
    runtimeEndpoint(
      { ...metadata, transports: [{ kind: 'named-pipe', endpoint: pipe }] },
      directory,
      'win32'
    ),
    pipe
  )
  assert.throws(
    () =>
      runtimeEndpoint(
        {
          ...metadata,
          transports: [{ kind: 'named-pipe', endpoint: '\\\\remote\\pipe\\orca-42-test' }]
        },
        directory,
        'win32'
      ),
    /local runtime socket/
  )
})

test(
  'runtime metadata readable by other users is rejected before connecting',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { data } = await fixture(t)
    const path = join(data, 'orca-runtime.json')
    await writeFile(path, '{}', { mode: 0o644 })
    await chmod(path, 0o644)
    await assert.rejects(createSessionTabClient(data), /private to the current user/)
  }
)

test('terminal navigation uses only the bundled entry with constrained arguments and environment', async (t) => {
  const { root } = await fixture(t)
  await mkdir(join(root, 'main'))
  await mkdir(join(root, 'cli'))
  await writeFile(join(root, 'cli', 'index.js'), '')
  const worker = join(root, 'main', 'plugin-host-entry.js')
  const env = {
    HOME: root,
    PATH: '/untrusted/bin',
    NODE_OPTIONS: '--require /payload.js',
    ORCA_USER_DATA_PATH: '/other-host',
    OPENAI_API_KEY: 'never-forward',
    LD_PRELOAD: '/payload.so'
  }
  const spec = terminalCliSpec(['show', '--terminal', 'term_known'], worker, process.execPath, env)
  assert.equal(spec.program, process.execPath)
  assert.deepEqual(spec.args, [
    await realpath(join(root, 'cli', 'index.js')),
    'terminal',
    'show',
    '--terminal',
    'term_known',
    '--json'
  ])
  assert.deepEqual(spec.env, { HOME: root, ELECTRON_RUN_AS_NODE: '1' })
  for (const args of [
    ['send', '--terminal', 'term_known'],
    ['switch', '--terminal', '--environment=remote'],
    ['show', '--terminal', 'term_known', '--server', 'remote']
  ]) {
    assert.throws(
      () => terminalCliSpec(args, worker, process.execPath, env),
      /Unsupported terminal/
    )
  }
  await rm(join(root, 'cli', 'index.js'))
  assert.throws(() =>
    terminalCliSpec(['show', '--terminal', 'term_known'], worker, process.execPath, env)
  )
})
