import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { kernelActorKinds } from '../../shared/graph-core/types.js'
import type {
  GraphEvent,
  KernelActor,
  KernelActorKind,
} from '../../shared/graph-core/types.js'

type JsonRecord = Record<string, any>

// Kernel event shapes live in graph-core (the single source of truth for
// the kernel's pure logic); the store persists exactly that shape.
export type KernelEvent = GraphEvent
export type { KernelActor, KernelActorKind }
export { kernelActorKinds }

export type KernelEventInput = {
  type: string
  actor: KernelActor
  causeId?: string
  reason?: string
  payload?: JsonRecord
}

const kernelStoreSchema = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_ref TEXT,
  cause_id TEXT,
  reason TEXT,
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_type ON events(type);
CREATE INDEX IF NOT EXISTS events_cause ON events(cause_id);
CREATE TABLE IF NOT EXISTS snapshots (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  state TEXT NOT NULL
);
-- meta currently holds 'snapshot-owner': the epoch of the connection that
-- owns the snapshot slot (newest opener wins; stale writers are dropped).
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

function nowIso() {
  return new Date().toISOString()
}

function isObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function preserveCorruptDatabase(databaseFile: string) {
  const stamp = Date.now()
  const preserved: string[] = []
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${databaseFile}${suffix}`
    if (!fs.existsSync(file)) {
      continue
    }
    const corruptFile = `${file}.corrupt.${stamp}`
    try {
      fs.renameSync(file, corruptFile)
      preserved.push(corruptFile)
    } catch {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        // Nothing else we can do; the reopen attempt below will surface it.
      }
    }
  }
  return preserved
}

function openDatabase(databaseFile: string | undefined) {
  if (!databaseFile) {
    const db = new DatabaseSync(':memory:')
    db.exec(kernelStoreSchema)
    return { db, diagnostics: [] as JsonRecord[] }
  }

  fs.mkdirSync(path.dirname(databaseFile), { recursive: true })
  const diagnostics: JsonRecord[] = []

  const tryOpen = () => {
    const db = new DatabaseSync(databaseFile)
    // Restart-recovery flows legitimately open a second connection on the
    // same store while the old one still persists; queue writers briefly
    // instead of surfacing SQLITE_BUSY.
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(kernelStoreSchema)
    return db
  }

  try {
    return { db: tryOpen(), diagnostics }
  } catch (error) {
    const preservedFiles = preserveCorruptDatabase(databaseFile)
    diagnostics.push({
      code: 'kernel-store.corrupt_database_preserved',
      message: 'Kernel event database could not be opened; starting a fresh one.',
      context: {
        databaseFile,
        error: error instanceof Error ? error.message : String(error),
        preservedFiles,
      },
    })
  }

  try {
    return { db: tryOpen(), diagnostics }
  } catch (error) {
    diagnostics.push({
      code: 'kernel-store.fallback_in_memory',
      message:
        'Kernel event database could not be recreated; events for this run are not durable.',
      context: {
        databaseFile,
        error: error instanceof Error ? error.message : String(error),
      },
    })
    const db = new DatabaseSync(':memory:')
    db.exec(kernelStoreSchema)
    return { db, diagnostics }
  }
}

function rowToEvent(row: JsonRecord): KernelEvent {
  let payload: JsonRecord = {}
  try {
    const parsed = JSON.parse(String(row.payload ?? '{}'))
    payload = isObject(parsed) ? parsed : {}
  } catch {
    payload = {}
  }

  return {
    seq: Number(row.seq),
    id: String(row.id),
    ts: String(row.ts),
    type: String(row.type),
    actor: {
      kind: String(row.actor_kind) as KernelActorKind,
      ref: row.actor_ref === null || row.actor_ref === undefined ? undefined : String(row.actor_ref),
    },
    causeId: row.cause_id === null || row.cause_id === undefined ? undefined : String(row.cause_id),
    reason: row.reason === null || row.reason === undefined ? undefined : String(row.reason),
    payload,
  }
}

export class KernelStore {
  #db: DatabaseSync
  #closed = false
  // Each store connection claims ownership of the snapshot slot on open.
  // A newer connection (restart recovery) takes over; late writes from the
  // previous owner are dropped instead of clobbering the newer snapshot.
  #epoch = randomUUID()
  #staleSnapshotWarned = false
  databaseFile: string | undefined
  diagnostics: JsonRecord[] = []

  constructor({ databaseFile }: { databaseFile?: string } = {}) {
    this.databaseFile = databaseFile
    this.#open()
  }

  #open() {
    const { db, diagnostics } = openDatabase(this.databaseFile)
    this.#db = db
    this.diagnostics.push(...diagnostics)
    try {
      this.#db
        .prepare(
          `INSERT INTO meta (key, value) VALUES ('snapshot-owner', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .run(this.#epoch)
    } catch {
      // Ownership is best-effort; snapshot writes fall back to last-writer-wins.
    }
  }

  // Constructor-time corruption that survived a successful open (page-level
  // damage surfacing on first read): preserve the damaged files and restart
  // with a fresh store, mirroring the open-time recovery path.
  #recoverFromReadCorruption(stage: string, error: unknown) {
    this.diagnostics.push({
      code: 'kernel-store.corrupt_database_preserved',
      message: `Kernel event database failed during ${stage}; starting a fresh one.`,
      context: {
        databaseFile: this.databaseFile,
        error: error instanceof Error ? error.message : String(error),
      },
    })
    try {
      this.#db.close()
    } catch {
      // The handle may already be unusable; preservation below still applies.
    }
    if (this.databaseFile) {
      preserveCorruptDatabase(this.databaseFile)
    }
    this.#open()
  }

  get closed() {
    return this.#closed
  }

  appendEvent(input: KernelEventInput): KernelEvent | undefined {
    if (this.#closed) {
      return undefined
    }

    if (!isObject(input.actor) || !kernelActorKinds.has(input.actor.kind)) {
      throw new Error(`Kernel event requires a valid actor: ${JSON.stringify(input.actor)}`)
    }
    if (typeof input.type !== 'string' || input.type.trim().length === 0) {
      throw new Error('Kernel event type is required')
    }

    const event = {
      id: randomUUID(),
      ts: nowIso(),
      type: input.type,
      actor: { kind: input.actor.kind, ref: input.actor.ref },
      causeId: input.causeId,
      reason: input.reason,
      payload: isObject(input.payload) ? input.payload : {},
    }

    const result = this.#db
      .prepare(
        `INSERT INTO events (id, ts, type, actor_kind, actor_ref, cause_id, reason, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.ts,
        event.type,
        event.actor.kind,
        event.actor.ref ?? null,
        event.causeId ?? null,
        event.reason ?? null,
        JSON.stringify(event.payload)
      )

    return { seq: Number(result.lastInsertRowid), ...event }
  }

  listEvents({
    sinceSeq = 0,
    limit = 500,
    type,
    tail = false,
  }: { sinceSeq?: number; limit?: number; type?: string; tail?: boolean } = {}): KernelEvent[] {
    if (this.#closed) {
      return []
    }

    const boundedLimit = Math.max(1, Math.min(Number(limit) || 500, 2000))
    const since = Number.isFinite(Number(sinceSeq)) ? Number(sinceSeq) : 0
    // tail: the NEWEST N matching events (still returned in ascending seq
    // order) — what a live timeline wants when the log is long.
    const order = tail ? 'DESC' : 'ASC'
    const rows = type
      ? this.#db
          .prepare(
            `SELECT * FROM events WHERE seq > ? AND type = ? ORDER BY seq ${order} LIMIT ?`
          )
          .all(since, type, boundedLimit)
      : this.#db
          .prepare(`SELECT * FROM events WHERE seq > ? ORDER BY seq ${order} LIMIT ?`)
          .all(since, boundedLimit)
    const events = rows.map((row) => rowToEvent(row as JsonRecord))
    return tail ? events.reverse() : events
  }

  latestSeq(): number {
    if (this.#closed) {
      return 0
    }

    const row = this.#db.prepare('SELECT MAX(seq) AS seq FROM events').get() as
      | JsonRecord
      | undefined
    return Number(row?.seq ?? 0) || 0
  }

  eventCount(): number {
    if (this.#closed) {
      return 0
    }

    const row = this.#db.prepare('SELECT COUNT(*) AS count FROM events').get() as
      | JsonRecord
      | undefined
    return Number(row?.count ?? 0) || 0
  }

  saveSnapshot(state: JsonRecord) {
    if (this.#closed) {
      return
    }
    // In-memory stores are never reloaded; persisting a snapshot into them
    // would be pure serialization overhead on every touch.
    if (!this.databaseFile) {
      return
    }
    if (this.getMeta('snapshot-owner') !== this.#epoch) {
      if (!this.#staleSnapshotWarned) {
        this.#staleSnapshotWarned = true
        console.warn(
          `A newer runtime took over ${this.databaseFile}; dropping snapshot writes from this stale connection.`
        )
      }
      return
    }

    const seq = this.latestSeq()
    const ts = nowIso()
    const serialized = JSON.stringify(state)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare('DELETE FROM snapshots').run()
      this.#db
        .prepare('INSERT INTO snapshots (seq, ts, state) VALUES (?, ?, ?)')
        .run(seq, ts, serialized)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  loadSnapshot(): { seq: number; ts: string; state: JsonRecord } | undefined {
    if (this.#closed) {
      return undefined
    }

    let row: JsonRecord | undefined
    try {
      row = this.#db
        .prepare('SELECT seq, ts, state FROM snapshots ORDER BY seq DESC LIMIT 1')
        .get() as JsonRecord | undefined
    } catch (error) {
      this.#recoverFromReadCorruption('snapshot read', error)
      return undefined
    }
    if (!row) {
      return undefined
    }

    try {
      const state = JSON.parse(String(row.state))
      if (!isObject(state)) {
        return undefined
      }
      return { seq: Number(row.seq), ts: String(row.ts), state }
    } catch {
      return undefined
    }
  }

  hasSnapshot(): boolean {
    if (this.#closed) {
      return false
    }

    const row = this.#db.prepare('SELECT COUNT(*) AS count FROM snapshots').get() as
      | JsonRecord
      | undefined
    return Number(row?.count ?? 0) > 0
  }

  getMeta(key: string): string | undefined {
    if (this.#closed) {
      return undefined
    }

    const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | JsonRecord
      | undefined
    return row ? String(row.value) : undefined
  }

  setMeta(key: string, value: string) {
    if (this.#closed) {
      return
    }

    this.#db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  close() {
    if (this.#closed) {
      return
    }

    this.#closed = true
    try {
      this.#db.close()
    } catch {
      // Closing a database twice (or after a failed open) is not actionable.
    }
  }
}

export function kernelDatabaseFileFor(storageFile: string) {
  return `${storageFile.replace(/\.json$/, '')}.sqlite`
}
