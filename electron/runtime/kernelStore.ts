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
  id?: string
  ts?: string
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
-- M0B control-plane authority. snapshots remains a compatibility mirror
-- during migration; new command commits update both rows in one transaction.
CREATE TABLE IF NOT EXISTS runtime_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL,
  event_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS command_records (
  command_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  kind TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_ref TEXT,
  expected_version INTEGER,
  committed_version INTEGER NOT NULL,
  committed_event_seq INTEGER NOT NULL,
  result TEXT NOT NULL DEFAULT '{}',
  execution TEXT,
  committed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS command_records_idempotency
  ON command_records(idempotency_key);
CREATE TABLE IF NOT EXISTS workflow_deployments (
  deployment_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  journal TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_deployments_status
  ON workflow_deployments(status);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_deployments_command
  ON workflow_deployments(command_id);
CREATE TABLE IF NOT EXISTS effect_outbox (
  effect_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS effect_outbox_status ON effect_outbox(status);
-- meta currently holds 'snapshot-owner': the epoch of the connection that
-- owns the snapshot slot (newest opener wins; stale writers are dropped).
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

function initializeSchema(db: DatabaseSync) {
  db.exec(kernelStoreSchema)
  const commandColumns = db.prepare('PRAGMA table_info(command_records)').all() as JsonRecord[]
  if (!commandColumns.some((column) => column.name === 'execution')) {
    db.exec('ALTER TABLE command_records ADD COLUMN execution TEXT')
  }
}

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
    initializeSchema(db)
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
    initializeSchema(db)
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
    initializeSchema(db)
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

function parseJsonRecord(value: unknown): JsonRecord {
  try {
    const parsed = JSON.parse(String(value ?? '{}'))
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export class ControlVersionConflictError extends Error {
  expectedVersion: number
  actualVersion: number

  constructor(expectedVersion: number, actualVersion: number) {
    super(`Control state version conflict: expected ${expectedVersion}, current ${actualVersion}.`)
    this.name = 'ControlVersionConflictError'
    this.expectedVersion = expectedVersion
    this.actualVersion = actualVersion
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
      id: typeof input.id === 'string' && input.id.length > 0 ? input.id : randomUUID(),
      ts: typeof input.ts === 'string' && input.ts.length > 0 ? input.ts : nowIso(),
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

  loadDurableState(): { version: number; eventSeq: number; updatedAt: string; state: JsonRecord } | undefined {
    if (this.#closed) return undefined
    const row = this.#db
      .prepare('SELECT version, event_seq, updated_at, state FROM runtime_state WHERE singleton = 1')
      .get() as JsonRecord | undefined
    if (!row) return undefined
    const state = parseJsonRecord(row.state)
    if (Object.keys(state).length === 0) return undefined
    return {
      version: Number(row.version) || 0,
      eventSeq: Number(row.event_seq) || 0,
      updatedAt: String(row.updated_at),
      state,
    }
  }

  getControlVersion(): number {
    if (this.#closed) return 0
    const row = this.#db
      .prepare('SELECT version FROM runtime_state WHERE singleton = 1')
      .get() as JsonRecord | undefined
    return Number(row?.version ?? 0) || 0
  }

  getCommandRecord({ commandId, idempotencyKey }: { commandId?: string; idempotencyKey?: string }) {
    if (this.#closed) return undefined
    const row = commandId && idempotencyKey
      ? this.#db
          .prepare('SELECT * FROM command_records WHERE command_id = ? OR idempotency_key = ? LIMIT 1')
          .get(commandId, idempotencyKey)
      : commandId
        ? this.#db.prepare('SELECT * FROM command_records WHERE command_id = ?').get(commandId)
      : idempotencyKey
        ? this.#db.prepare('SELECT * FROM command_records WHERE idempotency_key = ?').get(idempotencyKey)
        : undefined
    if (!row) return undefined
    const value = row as JsonRecord
    return {
      commandId: String(value.command_id),
      idempotencyKey: value.idempotency_key == null ? undefined : String(value.idempotency_key),
      kind: String(value.kind),
      actor: {
        kind: String(value.actor_kind) as KernelActorKind,
        ref: value.actor_ref == null ? undefined : String(value.actor_ref),
      },
      expectedVersion: value.expected_version == null ? undefined : Number(value.expected_version),
      committedVersion: Number(value.committed_version),
      committedEventSeq: Number(value.committed_event_seq),
      result: parseJsonRecord(value.result),
      execution: value.execution == null ? undefined : parseJsonRecord(value.execution),
      committedAt: String(value.committed_at),
    }
  }

  commitControlCommand({
    state,
    events = [],
    command,
    result = {},
    deploymentFinalizations = [],
    outboxEffects = [],
  }: {
    state: JsonRecord
    events?: KernelEventInput[]
    command: {
      commandId: string
      idempotencyKey?: string
      kind: string
      actor: KernelActor
      expectedVersion?: number
      execution?: JsonRecord
      affectsControlVersion?: boolean
    }
    result?: JsonRecord
    deploymentFinalizations?: Array<{
      deploymentId: string
      stage: string
      status: string
      journal?: JsonRecord
    }>
    outboxEffects?: Array<{
      effectId: string
      kind: string
      payload?: JsonRecord
    }>
  }) {
    if (this.#closed) throw new Error('Kernel store is closed.')
    if (!command?.commandId || !command?.kind) throw new Error('Control command identity and kind are required.')
    if (!isObject(command.actor) || !kernelActorKinds.has(command.actor.kind)) {
      throw new Error('Control command requires a valid actor.')
    }
    if (this.databaseFile && this.getMeta('snapshot-owner') !== this.#epoch) {
      throw new Error('A newer runtime owns the durable control state.')
    }

    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const duplicate = this.getCommandRecord({
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
      })
      if (duplicate) {
        this.#db.exec('COMMIT')
        return { duplicate: true, record: duplicate, events: [] as KernelEvent[] }
      }

      const currentVersion = this.getControlVersion()
      if (
        Number.isInteger(command.expectedVersion) &&
        command.expectedVersion !== currentVersion
      ) {
        throw new ControlVersionConflictError(command.expectedVersion, currentVersion)
      }

      const committedEvents: KernelEvent[] = []
      for (const input of events) {
        if (!isObject(input.actor) || !kernelActorKinds.has(input.actor.kind)) {
          throw new Error(`Kernel event requires a valid actor: ${JSON.stringify(input.actor)}`)
        }
        if (typeof input.type !== 'string' || input.type.trim().length === 0) {
          throw new Error('Kernel event type is required')
        }
        const event = {
          id: typeof input.id === 'string' && input.id.length > 0 ? input.id : randomUUID(),
          ts: typeof input.ts === 'string' && input.ts.length > 0 ? input.ts : nowIso(),
          type: input.type,
          actor: { kind: input.actor.kind, ref: input.actor.ref },
          causeId: input.causeId,
          reason: input.reason,
          payload: isObject(input.payload) ? input.payload : {},
        }
        const inserted = this.#db.prepare(
          `INSERT INTO events (id, ts, type, actor_kind, actor_ref, cause_id, reason, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          event.id,
          event.ts,
          event.type,
          event.actor.kind,
          event.actor.ref ?? null,
          event.causeId ?? null,
          event.reason ?? null,
          JSON.stringify(event.payload),
        )
        committedEvents.push({ seq: Number(inserted.lastInsertRowid), ...event })
      }

      const committedVersion = command.affectsControlVersion === false
        ? currentVersion
        : currentVersion + 1
      const committedEventSeq = committedEvents.at(-1)?.seq ?? this.latestSeq()
      const committedAt = nowIso()
      const durableState = { ...state, controlVersion: committedVersion }
      const committedResult = isObject(result) ? structuredClone(result) : {}
      if (isObject(committedResult.state)) {
        committedResult.state.controlVersion = committedVersion
      }
      if ('controlVersion' in committedResult) {
        committedResult.controlVersion = committedVersion
      }
      const serializedState = JSON.stringify(durableState)
      this.#db.prepare(
        `INSERT INTO runtime_state (singleton, version, event_seq, updated_at, state)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           version = excluded.version,
           event_seq = excluded.event_seq,
           updated_at = excluded.updated_at,
           state = excluded.state`,
      ).run(committedVersion, committedEventSeq, committedAt, serializedState)
      this.#db.prepare('DELETE FROM snapshots').run()
      this.#db.prepare('INSERT INTO snapshots (seq, ts, state) VALUES (?, ?, ?)')
        .run(committedEventSeq, committedAt, serializedState)
      for (const finalization of deploymentFinalizations) {
        const deployment = this.getWorkflowDeployment(finalization.deploymentId)
        if (!deployment) {
          throw new Error(`Unknown workflow deployment: ${finalization.deploymentId}`)
        }
        this.#db.prepare(
          `UPDATE workflow_deployments
           SET stage = ?, status = ?, journal = ?, updated_at = ?
           WHERE deployment_id = ?`,
        ).run(
          finalization.stage,
          finalization.status,
          JSON.stringify({ ...deployment.journal, ...(finalization.journal ?? {}) }),
          committedAt,
          finalization.deploymentId,
        )
      }
      for (const effect of outboxEffects) {
        this.#db.prepare(
          `INSERT INTO effect_outbox
            (effect_id, command_id, kind, payload, status, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?)
           ON CONFLICT(effect_id) DO NOTHING`,
        ).run(
          effect.effectId,
          command.commandId,
          effect.kind,
          JSON.stringify(effect.payload ?? {}),
          committedAt,
        )
      }
      this.#db.prepare(
        `INSERT INTO command_records
          (command_id, idempotency_key, kind, actor_kind, actor_ref, expected_version,
           committed_version, committed_event_seq, result, execution, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        command.commandId,
        command.idempotencyKey ?? null,
        command.kind,
        command.actor.kind,
        command.actor.ref ?? null,
        command.expectedVersion ?? null,
        committedVersion,
        committedEventSeq,
        JSON.stringify(committedResult),
        command.execution ? JSON.stringify(command.execution) : null,
        committedAt,
      )
      this.#db.exec('COMMIT')
      return {
        duplicate: false,
        record: this.getCommandRecord({ commandId: command.commandId }),
        events: committedEvents,
        state: durableState,
      }
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  createWorkflowDeployment(input: {
    deploymentId: string
    workflowId: string
    commandId: string
    stage?: string
    journal?: JsonRecord
  }) {
    if (this.#closed) throw new Error('Kernel store is closed.')
    const ts = nowIso()
    this.#db.prepare(
      `INSERT INTO workflow_deployments
        (deployment_id, workflow_id, command_id, stage, status, journal, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'in_progress', ?, ?, ?)
       ON CONFLICT(deployment_id) DO NOTHING`,
    ).run(
      input.deploymentId,
      input.workflowId,
      input.commandId,
      input.stage ?? 'prepared',
      JSON.stringify(input.journal ?? {}),
      ts,
      ts,
    )
    return this.getWorkflowDeployment(input.deploymentId)
  }

  getWorkflowDeployment(deploymentId: string) {
    if (this.#closed) return undefined
    const row = this.#db
      .prepare('SELECT * FROM workflow_deployments WHERE deployment_id = ?')
      .get(deploymentId) as JsonRecord | undefined
    return row ? this.#deploymentRow(row) : undefined
  }

  getWorkflowDeploymentByCommandId(commandId: string) {
    if (this.#closed) return undefined
    const row = this.#db
      .prepare('SELECT * FROM workflow_deployments WHERE command_id = ?')
      .get(commandId) as JsonRecord | undefined
    return row ? this.#deploymentRow(row) : undefined
  }

  listWorkflowDeployments({ status }: { status?: string } = {}) {
    if (this.#closed) return []
    const rows = status
      ? this.#db.prepare('SELECT * FROM workflow_deployments WHERE status = ? ORDER BY created_at').all(status)
      : this.#db.prepare('SELECT * FROM workflow_deployments ORDER BY created_at').all()
    return rows.map((row) => this.#deploymentRow(row as JsonRecord))
  }

  updateWorkflowDeployment(
    deploymentId: string,
    input: { stage?: string; status?: string; journal?: JsonRecord; expectedStage?: string },
  ) {
    if (this.#closed) throw new Error('Kernel store is closed.')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.getWorkflowDeployment(deploymentId)
      if (!current) throw new Error(`Unknown workflow deployment: ${deploymentId}`)
      if (input.expectedStage && current.stage !== input.expectedStage) {
        throw new Error(
          `Workflow deployment ${deploymentId} stage conflict: expected ${input.expectedStage}, current ${current.stage}.`,
        )
      }
      const journal = { ...current.journal, ...(input.journal ?? {}) }
      this.#db.prepare(
        `UPDATE workflow_deployments
         SET stage = ?, status = ?, journal = ?, updated_at = ?
         WHERE deployment_id = ?`,
      ).run(
        input.stage ?? current.stage,
        input.status ?? current.status,
        JSON.stringify(journal),
        nowIso(),
        deploymentId,
      )
      this.#db.exec('COMMIT')
      return this.getWorkflowDeployment(deploymentId)
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  listPendingEffects() {
    if (this.#closed) return []
    return this.#db.prepare(
      `SELECT effect_id, command_id, kind, payload, status, created_at, completed_at
       FROM effect_outbox WHERE status = 'pending' ORDER BY created_at, effect_id`,
    ).all().map((row: JsonRecord) => ({
      effectId: String(row.effect_id),
      commandId: String(row.command_id),
      kind: String(row.kind),
      payload: parseJsonRecord(row.payload),
      status: String(row.status),
      createdAt: String(row.created_at),
    }))
  }

  completeEffect(effectId: string) {
    if (this.#closed) throw new Error('Kernel store is closed.')
    this.#db.prepare(
      `UPDATE effect_outbox SET status = 'completed', completed_at = ?
       WHERE effect_id = ? AND status = 'pending'`,
    ).run(nowIso(), effectId)
  }

  completeEffectWithEvent(
    effectId: string,
    input: KernelEventInput,
  ) {
    if (this.#closed) throw new Error('Kernel store is closed.')
    if (this.databaseFile && this.getMeta('snapshot-owner') !== this.#epoch) {
      throw new Error('A newer runtime owns the durable control state.')
    }
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const effect = this.#db.prepare(
        `SELECT status FROM effect_outbox WHERE effect_id = ?`,
      ).get(effectId) as JsonRecord | undefined
      if (!effect) throw new Error(`Unknown durable effect: ${effectId}`)
      if (effect.status !== 'pending') {
        this.#db.exec('COMMIT')
        return undefined
      }
      if (!isObject(input.actor) || !kernelActorKinds.has(input.actor.kind)) {
        throw new Error('Kernel event requires a valid actor.')
      }
      if (typeof input.type !== 'string' || input.type.trim().length === 0) {
        throw new Error('Kernel event type is required')
      }
      const event = {
        id: input.id ?? randomUUID(),
        ts: input.ts ?? nowIso(),
        type: input.type,
        actor: input.actor,
        causeId: input.causeId,
        reason: input.reason,
        payload: input.payload ?? {},
      }
      const inserted = this.#db.prepare(
        `INSERT INTO events (id, ts, type, actor_kind, actor_ref, cause_id, reason, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.id,
        event.ts,
        event.type,
        event.actor.kind,
        event.actor.ref ?? null,
        event.causeId ?? null,
        event.reason ?? null,
        JSON.stringify(event.payload),
      )
      this.#db.prepare(
        `UPDATE effect_outbox SET status = 'completed', completed_at = ?
         WHERE effect_id = ? AND status = 'pending'`,
      ).run(event.ts, effectId)
      this.#db.exec('COMMIT')
      return { seq: Number(inserted.lastInsertRowid), ...event }
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #deploymentRow(row: JsonRecord) {
    return {
      deploymentId: String(row.deployment_id),
      workflowId: String(row.workflow_id),
      commandId: String(row.command_id),
      stage: String(row.stage),
      status: String(row.status),
      journal: parseJsonRecord(row.journal),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
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

  // The newest event of `type` whose payload carries `payloadValue` under
  // `payloadKey`. Exact per-key lookup — unlike a bounded listEvents tail,
  // this cannot miss an old fact for a quiet subscription.
  latestEventWithPayloadValue(
    type: string,
    payloadKey: string,
    payloadValue: string
  ): KernelEvent | undefined {
    if (this.#closed) {
      return undefined
    }

    const row = this.#db
      .prepare(
        `SELECT * FROM events
         WHERE type = ? AND json_extract(payload, ?) = ?
         ORDER BY seq DESC LIMIT 1`
      )
      .get(type, `$.${payloadKey}`, payloadValue) as JsonRecord | undefined
    return row ? rowToEvent(row) : undefined
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
    const version = this.getControlVersion()
    const durableState = { ...state, controlVersion: version }
    const serialized = JSON.stringify(durableState)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare(
        `INSERT INTO runtime_state (singleton, version, event_seq, updated_at, state)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           event_seq = excluded.event_seq,
           updated_at = excluded.updated_at,
           state = excluded.state`,
      ).run(version, seq, ts, serialized)
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
