// L2 external source adapters: thin translators between the outside world
// and the runtime's ingestion choke point (sessionManager.emitExternalEvent).
//
// An adapter never touches the kernel. It only calls emit(); acceptance,
// sampling, and dedupe are the choke point's job. The corollary is the
// re-emit principle (graph-core/external.ts): adapters report CURRENT state
// on every beat and let consecutive-duplicate suppression drop the noise —
// so a dropped emit needs no adapter-side retry bookkeeping.
//
// Failures stay on the source side: a crashing script or an unreadable repo
// records an operational error via onError and emits nothing. Garbage in
// the log is worse than silence.

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import readline from 'node:readline'

type JsonRecord = Record<string, any>

export type AdapterEmit = (input: {
  payload: JsonRecord
  dedupeKey?: string
}) => { ok: boolean; reason?: string }

export type AdapterHooks = {
  emit: AdapterEmit
  onError: (message: string) => void
}

export type ExternalSourceAdapter = {
  start: () => void
  stop: () => void
}

const stdoutTailBytes = 8 * 1024

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

// --- script source ---
//
// config: { command, args?, cwd?, mode?: 'lines' | 'exit',
//           everySeconds? (exit mode), restartSeconds? (lines mode) }
//
// lines mode — a long-running watcher process; every stdout line is one
// event. A JSON-object line becomes the payload (a top-level "dedupeKey"
// field is extracted as the dedupe key); any other line becomes {line}.
//
// exit mode — a poll script run every everySeconds; each completed run is
// one event {exitCode, output}. The dedupe key is a hash of the run's
// outcome, so an unchanged poll result never reaches the log — exactly the
// "shell script watching CI" semantics the proposal describes.
export class ScriptSourceAdapter implements ExternalSourceAdapter {
  #source: JsonRecord
  #hooks: AdapterHooks
  #child: ReturnType<typeof spawn> | undefined
  #timer: NodeJS.Timeout | undefined
  #stopped = true

  constructor(source: JsonRecord, hooks: AdapterHooks) {
    this.#source = source
    this.#hooks = hooks
  }

  start() {
    this.#stopped = false
    if ((this.#source.config?.mode ?? 'lines') === 'exit') {
      this.#runExitMode()
    } else {
      this.#spawnLinesMode()
    }
  }

  stop() {
    this.#stopped = true
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    if (this.#child) {
      try {
        this.#child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
      this.#child = undefined
    }
  }

  #emitSafely(payload: JsonRecord, dedupeKey?: string) {
    try {
      this.#hooks.emit({ payload, ...(dedupeKey ? { dedupeKey } : {}) })
    } catch (error) {
      // Reserved keys / oversized payloads are the script's bug, not ours.
      this.#hooks.onError(error instanceof Error ? error.message : String(error))
    }
  }

  #spawnLinesMode() {
    if (this.#stopped) {
      return
    }
    const config = this.#source.config ?? {}
    let child
    try {
      child = spawn(config.command, config.args ?? [], {
        cwd: config.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.#hooks.onError(error instanceof Error ? error.message : String(error))
      return
    }
    this.#child = child
    child.on('error', (error) => {
      this.#hooks.onError(`Script source failed to start: ${error.message}`)
    })
    const lines = readline.createInterface({ input: child.stdout! })
    lines.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) {
        return
      }
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const { dedupeKey, ...payload } = parsed
            this.#emitSafely(
              payload,
              typeof dedupeKey === 'string' && dedupeKey ? dedupeKey : undefined
            )
            return
          }
        } catch {
          // Fall through: a brace-shaped but unparseable line is just text.
        }
      }
      this.#emitSafely({ line: trimmed })
    })
    child.on('close', (code) => {
      if (this.#child === child) {
        this.#child = undefined
      }
      if (this.#stopped) {
        return
      }
      const restartSeconds = Number(this.#source.config?.restartSeconds)
      if (Number.isFinite(restartSeconds) && restartSeconds > 0) {
        this.#timer = setTimeout(
          () => this.#spawnLinesMode(),
          Math.max(restartSeconds, 1) * 1000
        )
        this.#timer.unref?.()
      } else if (code !== 0 && code !== null) {
        this.#hooks.onError(`Script source exited with code ${code}.`)
      }
    })
  }

  #runExitMode() {
    if (this.#stopped) {
      return
    }
    const config = this.#source.config ?? {}
    const startedAt = Date.now()
    // The handle is retained so stop() can terminate an in-flight (or
    // stuck) poll — removeExternalSource/killAll must not leak children.
    const child = execFile(
      config.command,
      config.args ?? [],
      { cwd: config.cwd, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (this.#child === child) {
          this.#child = undefined
        }
        if (this.#stopped) {
          return
        }
        const exitCode = error && typeof error.code === 'number' ? error.code : error ? 1 : 0
        if (error && error.code === undefined) {
          // Spawn-level failure (ENOENT etc.), not a nonzero exit.
          this.#hooks.onError(`Script source run failed: ${error.message}`)
        } else {
          const output = String(stdout ?? '').slice(-stdoutTailBytes)
          this.#emitSafely(
            {
              exitCode,
              output,
              durationMs: Date.now() - startedAt,
            },
            // Unchanged outcome → same key → consecutive dedupe drops it.
            shortHash(`${exitCode}\n${output}`)
          )
        }
        const everySeconds = Number(config.everySeconds) || 60
        this.#timer = setTimeout(() => this.#runExitMode(), everySeconds * 1000)
        this.#timer.unref?.()
      }
    )
    this.#child = child
  }
}

// --- git watcher ---
//
// config: { repoPath, ref? (default 'HEAD'), pollSeconds? (default 5) }
//
// Polls one ref of a local repository (a working tree or a bare repo — a
// bare repo receiving a `git push file://…` is a real push, fully local)
// and emits the CURRENT head every beat; the choke point's consecutive
// dedupe (key = head sha) reduces that to one event per actual change.
export class GitWatcherAdapter implements ExternalSourceAdapter {
  #source: JsonRecord
  #hooks: AdapterHooks
  #timer: NodeJS.Timeout | undefined
  #stopped = true
  // The last head the choke point ACCEPTED — not the last one seen. A
  // sampling-dropped change keeps re-emitting on every poll until it lands
  // (the re-emit principle); an accepted one goes quiet.
  #lastAcceptedHead: string | undefined
  #polling = false

  constructor(source: JsonRecord, hooks: AdapterHooks) {
    this.#source = source
    this.#hooks = hooks
  }

  start() {
    this.#stopped = false
    void this.#poll()
  }

  stop() {
    this.#stopped = true
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  #schedule() {
    if (this.#stopped) {
      return
    }
    const pollSeconds = Number(this.#source.config?.pollSeconds) || 5
    this.#timer = setTimeout(() => void this.#poll(), pollSeconds * 1000)
    this.#timer.unref?.()
  }

  #git(args: string[]): Promise<string> {
    const repoPath = this.#source.config?.repoPath
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', repoPath, ...args],
        { maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            reject(error)
          } else {
            resolve(String(stdout).trim())
          }
        }
      )
    })
  }

  async #poll() {
    if (this.#stopped || this.#polling) {
      return
    }
    this.#polling = true
    try {
      const ref = this.#source.config?.ref ?? 'HEAD'
      const head = await this.#git(['rev-parse', '--verify', `${ref}^{commit}`])
      if (head && head !== this.#lastAcceptedHead) {
        let subject = ''
        try {
          subject = await this.#git(['log', '-1', '--format=%s', head])
        } catch {
          // Subject is decoration; the head fact stands on its own.
        }
        const accepted = this.#emitHead(ref, head, subject)
        if (accepted) {
          this.#lastAcceptedHead = head
        }
      }
    } catch (error) {
      this.#hooks.onError(
        `Git watcher poll failed: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      this.#polling = false
      this.#schedule()
    }
  }

  #emitHead(ref: string, head: string, subject: string): boolean {
    try {
      const result = this.#hooks.emit({
        payload: {
          repo: this.#source.config?.repoPath,
          ref,
          head,
          ...(this.#lastAcceptedHead ? { previousHead: this.#lastAcceptedHead } : {}),
          ...(subject ? { subject } : {}),
        },
        dedupeKey: head,
      })
      // A duplicate drop counts as accepted — the log already knows this
      // head (e.g. re-detected after a runtime restart).
      return result?.ok === true || /Duplicate/.test(result?.reason ?? '')
    } catch (error) {
      this.#hooks.onError(error instanceof Error ? error.message : String(error))
      return false
    }
  }
}

export function createExternalSourceAdapter(
  source: JsonRecord,
  hooks: AdapterHooks
): ExternalSourceAdapter | undefined {
  if (source.kind === 'script') {
    return new ScriptSourceAdapter(source, hooks)
  }
  if (source.kind === 'git') {
    return new GitWatcherAdapter(source, hooks)
  }
  // webhook and manual sources are pure ingestion-endpoint consumers.
  return undefined
}
