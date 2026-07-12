// Context channel: the data plane of the session graph (kernel doc §4).
//
// Every session has an inbox directory outside any project repo. Deliveries
// are immutable, sequence-numbered directories with a manifest; a new
// delivery on the same topic semantically supersedes the older one (P6 —
// "latest diff" needs no magic references). The channel is a natural
// coalesce buffer: deliveries accumulate while the target is busy, and one
// activation later reads the newest state.
//
// Red line (§2.5): control signals never travel through files. The channel
// carries data; the fact of a delivery is the kernel `delivered` event.
// The manifest mirrors those events for the reading agent's convenience —
// events are the truth if they ever disagree.

import fs from 'node:fs'
import path from 'node:path'
import type { ExecutionEnvelope } from '../../shared/execution-envelope.js'

export type ChannelDeliveryEntry = {
  seq: number
  from: string
  fromLabel?: string
  topic?: string
  note?: string
  files: string[]
  deliveredAt: string
  readAt?: string
  execution?: ExecutionEnvelope
}

export type ChannelDeliveryInput = {
  target: string
  from: string
  fromLabel?: string
  topic?: string
  note?: string
  // Named payload files written into the immutable delivery directory.
  entries?: Array<{ name: string; content: string }>
  execution?: ExecutionEnvelope
}

export type ChannelRetentionPolicy = {
  maxReadAgeDays?: number
  maxReadEntries?: number
  keepLatestReadPerTopic?: boolean
  dryRun?: boolean
}

function nowIso() {
  return new Date().toISOString()
}

function slug(value: string, maxLength = 24) {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.slice(0, maxLength) || 'delivery'
}

function safeFileName(name: string, fallback: string) {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]+/g, '-')
  return base.length > 0 && base !== '.' && base !== '..' ? base : fallback
}

export class ContextChannelStore {
  #root: string

  constructor({ root }: { root: string }) {
    // Canonicalize once so manifests and provider allowlists always carry
    // the same path form (macOS tmp roots are symlinks: /var → /private/var).
    let canonical = root
    try {
      fs.mkdirSync(root, { recursive: true })
      canonical = fs.realpathSync(root)
    } catch {
      canonical = root
    }
    this.#root = canonical
  }

  get root() {
    return this.#root
  }

  channelDir(sessionId: string) {
    // Session ids are runtime-generated UUIDs, but ids can also arrive from
    // restored state: enforce containment so a crafted id can never move
    // the inbox (and thus the provider read allowlist) outside the root.
    const dir = path.resolve(this.#root, sessionId)
    const relative = path.relative(this.#root, dir)
    if (
      relative.length === 0 ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      relative.includes(path.sep)
    ) {
      throw new Error(`Invalid channel session id: ${sessionId}`)
    }
    return dir
  }

  // Providers whitelist the inbox at session-controller init time (SDK
  // controllers are reused across turns), so the directory must exist from
  // the very first turn. Returns the realpath: on macOS the tmp root is a
  // symlink (/var → /private/var) and a non-canonical allowlist entry would
  // not match canonicalized file paths.
  ensureChannelDir(sessionId: string) {
    const dir = this.channelDir(sessionId)
    try {
      fs.mkdirSync(dir, { recursive: true })
      return fs.realpathSync(dir)
    } catch {
      return dir
    }
  }

  writeArtifact(workflowId: string, artifactId: string, content: string) {
    const file = this.artifactRef(workflowId, artifactId)
    const directory = path.dirname(file)
    fs.mkdirSync(directory, { recursive: true })
    const tempFile = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tempFile, content)
    fs.renameSync(tempFile, file)
    return file
  }

  artifactRef(workflowId: string, artifactId: string) {
    const safeWorkflow = slug(workflowId, 64)
    const safeArtifact = slug(artifactId, 64)
    const directory = path.join(this.#root, '_artifacts', safeWorkflow)
    return path.join(directory, `${safeArtifact}.md`)
  }

  readArtifact(contentRef: string) {
    const artifactsRoot = path.resolve(this.#root, '_artifacts')
    const file = path.resolve(contentRef)
    const relative = path.relative(artifactsRoot, file)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Artifact reference is outside the Orrery artifact store.')
    }
    return fs.readFileSync(file, 'utf8')
  }

  removeArtifacts(workflowId: string) {
    fs.rmSync(path.join(this.#root, '_artifacts', slug(workflowId, 64)), {
      recursive: true,
      force: true,
    })
  }

  #manifestFile(sessionId: string) {
    return path.join(this.channelDir(sessionId), 'manifest.json')
  }

  manifest(sessionId: string): ChannelDeliveryEntry[] {
    const file = this.#manifestFile(sessionId)
    if (!fs.existsSync(file)) {
      return []
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      // A torn manifest must not take the runtime down; deliveries are
      // recoverable from the kernel event log.
      return []
    }
  }

  checkpoint(sessionId: string): ChannelDeliveryEntry[] {
    return structuredClone(this.manifest(sessionId))
  }

  restore(sessionId: string, checkpoint: ChannelDeliveryEntry[]) {
    const keepSeqs = new Set(checkpoint.map((entry) => entry.seq))
    const channelDir = this.channelDir(sessionId)
    for (const entry of this.manifest(sessionId)) {
      if (keepSeqs.has(entry.seq)) continue
      const prefix = `${String(entry.seq).padStart(4, '0')}-`
      try {
        for (const name of fs.readdirSync(channelDir)) {
          if (name.startsWith(prefix)) {
            fs.rmSync(path.join(channelDir, name), { recursive: true, force: true })
          }
        }
      } catch {
        // A missing channel directory already represents the empty rollback.
      }
    }
    if (checkpoint.length > 0) {
      this.#writeManifest(sessionId, structuredClone(checkpoint))
    } else {
      try {
        fs.rmSync(this.#manifestFile(sessionId), { force: true })
      } catch {
        // The empty checkpoint is already restored.
      }
    }
  }

  #writeManifest(sessionId: string, entries: ChannelDeliveryEntry[]) {
    const file = this.#manifestFile(sessionId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tempFile = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tempFile, `${JSON.stringify(entries, null, 2)}\n`)
    fs.renameSync(tempFile, file)
  }

  deliver(input: ChannelDeliveryInput): ChannelDeliveryEntry {
    const entries = this.manifest(input.target)
    const seq = (entries.at(-1)?.seq ?? 0) + 1
    const dirName = [
      String(seq).padStart(4, '0'),
      'from',
      slug(input.fromLabel ?? input.from, 16),
      ...(input.topic ? [slug(input.topic)] : []),
    ].join('-')
    const deliveryDir = path.join(this.channelDir(input.target), dirName)
    fs.mkdirSync(deliveryDir, { recursive: true })

    const files: string[] = []
    const usedNames = new Set<string>()
    const uniqueName = (candidate: string) => {
      if (!usedNames.has(candidate)) {
        usedNames.add(candidate)
        return candidate
      }
      const extension = path.extname(candidate)
      const stem = candidate.slice(0, candidate.length - extension.length)
      let counter = 2
      while (usedNames.has(`${stem}-${counter}${extension}`)) {
        counter += 1
      }
      const deduped = `${stem}-${counter}${extension}`
      usedNames.add(deduped)
      return deduped
    }
    const payloadEntries = input.entries ?? []
    payloadEntries.forEach((payload, index) => {
      const fileName = uniqueName(
        safeFileName(payload.name, `payload-${index + 1}.md`)
      )
      const filePath = path.join(deliveryDir, fileName)
      fs.writeFileSync(filePath, payload.content)
      files.push(filePath)
    })
    if (input.note) {
      const notePath = path.join(deliveryDir, uniqueName('note.md'))
      fs.writeFileSync(notePath, `${input.note}\n`)
      files.push(notePath)
    }

    const entry: ChannelDeliveryEntry = {
      seq,
      from: input.from,
      fromLabel: input.fromLabel,
      topic: input.topic,
      note: input.note,
      files,
      deliveredAt: nowIso(),
      ...(input.execution ? { execution: structuredClone(input.execution) } : {}),
    }
    this.#writeManifest(input.target, [...entries, entry])
    return entry
  }

  // Unread deliveries with topic supersession applied: for entries sharing
  // a topic only the newest one is current (older ones are shadowed and
  // reported as superseded); topic-less deliveries all stay current.
  unread(sessionId: string): {
    current: ChannelDeliveryEntry[]
    superseded: ChannelDeliveryEntry[]
  } {
    const unreadEntries = this.manifest(sessionId).filter((entry) => !entry.readAt)
    const newestByTopic = new Map<string, number>()
    for (const entry of unreadEntries) {
      if (entry.topic) {
        newestByTopic.set(entry.topic, entry.seq)
      }
    }
    const current: ChannelDeliveryEntry[] = []
    const superseded: ChannelDeliveryEntry[] = []
    for (const entry of unreadEntries) {
      if (entry.topic && newestByTopic.get(entry.topic) !== entry.seq) {
        superseded.push(entry)
      } else {
        current.push(entry)
      }
    }
    return { current, superseded }
  }

  markRead(sessionId: string, upToSeq: number) {
    const entries = this.manifest(sessionId)
    let changed = false
    const ts = nowIso()
    for (const entry of entries) {
      if (!entry.readAt && entry.seq <= upToSeq) {
        entry.readAt = ts
        changed = true
      }
    }
    if (changed) {
      this.#writeManifest(sessionId, entries)
    }
  }

  // Rollback for activations whose run never actually started (spawn-level
  // failure): the agent never saw the listing, so exactly those deliveries
  // become unread again.
  unmarkRead(sessionId: string, seqs: number[]) {
    const wanted = new Set(seqs)
    if (wanted.size === 0) {
      return
    }
    const entries = this.manifest(sessionId)
    let changed = false
    for (const entry of entries) {
      if (entry.readAt && wanted.has(entry.seq)) {
        entry.readAt = undefined
        changed = true
      }
    }
    if (changed) {
      this.#writeManifest(sessionId, entries)
    }
  }

  cleanup(
    sessionId: string,
    {
      maxReadAgeDays = 30,
      maxReadEntries = 200,
      keepLatestReadPerTopic = true,
      dryRun = false,
    }: ChannelRetentionPolicy = {},
  ) {
    const entries = this.manifest(sessionId)
    const now = Date.now()
    const cutoff = now - Math.max(0, maxReadAgeDays) * 24 * 60 * 60 * 1000
    const readEntries = entries.filter((entry) => entry.readAt)
    const newestReadByTopic = new Map<string, number>()
    if (keepLatestReadPerTopic) {
      for (const entry of readEntries) {
        if (entry.topic) newestReadByTopic.set(entry.topic, entry.seq)
      }
    }
    const retainedReadCount = Math.max(0, maxReadEntries)
    const newestReadSeqs = new Set(
      (retainedReadCount > 0 ? readEntries.slice(-retainedReadCount) : []).map(
        (entry) => entry.seq,
      ),
    )
    const removable = entries.filter((entry) => {
      if (!entry.readAt) return false
      if (newestReadSeqs.has(entry.seq)) return false
      if (entry.topic && newestReadByTopic.get(entry.topic) === entry.seq) return false
      const readAt = Date.parse(entry.readAt)
      return Number.isFinite(readAt) && readAt < cutoff
    })
    const removableSeqs = new Set(removable.map((entry) => entry.seq))
    let removedBytes = 0
    for (const entry of removable) {
      for (const file of entry.files) {
        try {
          removedBytes += fs.statSync(file).size
        } catch {
          // Missing payload files are already reclaimed.
        }
      }
      if (dryRun) continue
      const prefix = `${String(entry.seq).padStart(4, '0')}-`
      try {
        for (const name of fs.readdirSync(this.channelDir(sessionId))) {
          if (name.startsWith(prefix)) {
            fs.rmSync(path.join(this.channelDir(sessionId), name), {
              recursive: true,
              force: true,
            })
          }
        }
      } catch {
        // Missing channel directory is equivalent to an empty cleanup.
      }
    }
    if (!dryRun && removable.length > 0) {
      this.#writeManifest(
        sessionId,
        entries.filter((entry) => !removableSeqs.has(entry.seq)),
      )
    }
    return {
      sessionId,
      removedDeliveries: removable.length,
      removedBytes,
      retainedDeliveries: entries.length - removable.length,
      policy: { maxReadAgeDays, maxReadEntries, keepLatestReadPerTopic },
    }
  }
}

// The deterministic activation preamble (§4.2.4): discovery must not rely
// on luck. Assembled by the runtime from the unread manifest — no LLM in
// the loop, which is what makes gate=auto safe (§6.1).
export function activationPreamble(
  unread: ReturnType<ContextChannelStore['unread']>,
  { channelDir }: { channelDir: string }
): string | undefined {
  const { current, superseded } = unread
  if (current.length === 0) {
    return undefined
  }

  const lines = [
    `Your context channel has ${current.length} new ${
      current.length === 1 ? 'delivery' : 'deliveries'
    } (inbox: ${channelDir}):`,
  ]
  current.forEach((entry, index) => {
    const parts = [
      `${index + 1}. from ${entry.fromLabel ?? entry.from}`,
      entry.topic ? `topic "${entry.topic}"` : undefined,
      entry.note ? `note: ${entry.note}` : undefined,
    ].filter(Boolean)
    lines.push(parts.join(', '))
    for (const file of entry.files) {
      lines.push(`   - ${file}`)
    }
  })
  if (superseded.length > 0) {
    lines.push(
      `(${superseded.length} older ${
        superseded.length === 1 ? 'delivery was' : 'deliveries were'
      } superseded by newer ones on the same topic.)`
    )
  }
  lines.push('Read the delivered files before acting on this activation.')
  return lines.join('\n')
}
