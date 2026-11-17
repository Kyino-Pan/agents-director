import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readSourceText } from './source-files.mjs'

const MAX_BYTES = 32 * 1024 * 1024
const MAX_ENTRIES = 10000

// Orca 1.4.257 stores the former JSON document in a row cache (schema 202).
// Read one SQLite snapshot; never fall back to stale JSON when a DB is present.
export async function readStatusCache(reader, directory, consume) {
  const databasePath = join(directory, 'agent-hooks', 'last-status.db')
  let exists = true
  try {
    await stat(databasePath)
  } catch (error) {
    // A broken/unreadable DB still takes precedence. Let scanSource report its
    // failure and continue with other directories instead of aborting the scan.
    if (error.code === 'ENOENT') exists = false
  }
  const path = exists ? databasePath : join(directory, 'agent-hooks', 'last-status.json')
  await reader.scanSource(path, async () => {
    let entries
    if (exists) {
      const db = reader.database(path)
      db.exec('BEGIN')
      try {
        const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
        if (version?.value !== '202') throw new Error('Unsupported Orca status cache schema.')
        // node:sqlite text results stop at NUL. Keys are entry\0<paneKey>, so
        // retain them as blobs until decoding, including in the SQL predicate.
        const prefix = Buffer.from('entry\0')
        const size = db
          .prepare(`SELECT COALESCE(SUM(length(CAST(value AS BLOB))), 0) AS bytes
            FROM rows WHERE substr(CAST(key AS BLOB), 1, 6) = ?`)
          .get(prefix)
        if (size.bytes > MAX_BYTES)
          throw new Error('Status cache exceeds the bounded reader limit.')
        const rows = db
          .prepare(`SELECT CAST(key AS BLOB) AS key, value FROM rows
            WHERE substr(CAST(key AS BLOB), 1, 6) = ? ORDER BY seq LIMIT ?`)
          .all(prefix, MAX_ENTRIES + 1)
        if (rows.length > MAX_ENTRIES)
          throw new Error('Status cache exceeds the pane reader limit.')
        entries = rows.map((row) => {
          const pane = Buffer.from(row.key).toString('utf8').slice(6)
          const value = JSON.parse(row.value)
          if (!pane || value?.paneKey !== pane)
            throw new Error('Invalid status cache pane identity.')
          return [pane, value]
        })
      } finally {
        db.exec('ROLLBACK')
      }
    } else {
      const text = await readSourceText(path, [directory], MAX_BYTES)
      entries = Object.entries(JSON.parse(text).entries ?? {})
    }
    for (const [pane, row] of entries) consume(pane, row)
    return `${entries.length} cached panes; cache alone does not prove live activity`
  })
}
