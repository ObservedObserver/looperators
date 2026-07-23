import type { JsonRecord, RuntimeEventEmitter } from './runtimeCommon.js'

export type BatchedRuntimeEventEmitter = RuntimeEventEmitter & {
  flush(): void
  dispose(): void
}

export function createBatchedRuntimeEventEmitter(
  emit: RuntimeEventEmitter,
  {
    batchMs = 50,
    maxEventsPerBatch = 200,
  }: {
    batchMs?: number
    maxEventsPerBatch?: number
  } = {},
): BatchedRuntimeEventEmitter {
  const pendingRuns: Array<{
    sessionId: string
    providerEvents: JsonRecord[]
  }> = []
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    const runs = pendingRuns.splice(0)
    for (const run of runs) {
      emit({
        type: 'session.stream',
        sessionId: run.sessionId,
        providerEvents: run.providerEvents,
      })
    }
  }

  const discard = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    pendingRuns.length = 0
  }

  const publish = ((event: JsonRecord) => {
    if (
      event?.type === 'provider.runtime' &&
      typeof event.sessionId === 'string' &&
      event.providerEvent
    ) {
      const lastRun = pendingRuns.at(-1)
      if (lastRun?.sessionId === event.sessionId) {
        lastRun.providerEvents.push(event.providerEvent)
      } else {
        pendingRuns.push({
          sessionId: event.sessionId,
          providerEvents: [event.providerEvent],
        })
      }
      if (pendingRuns.at(-1)!.providerEvents.length >= maxEventsPerBatch) {
        // Flush every earlier run as well; emitting only this Session would
        // reorder interleaved events from concurrently running Sessions.
        flush()
      }
      if (pendingRuns.length > 0 && !timer) {
        timer = setTimeout(flush, batchMs)
        timer.unref?.()
      }
      return
    }

    // State-bearing boundaries already contain every earlier provider event.
    // Replaying queued deltas after them would regress ordering and duplicate
    // work, so drop the covered batch. Other event kinds preserve ordering by
    // flushing the provider batch before they cross the host transport.
    if (event && 'state' in event) {
      discard()
    } else {
      flush()
    }
    emit(event)
  }) as BatchedRuntimeEventEmitter

  publish.flush = flush
  publish.dispose = () => {
    flush()
  }
  return publish
}
