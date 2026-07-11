import assert from 'node:assert/strict'
import test from 'node:test'

import { createFrameResizeObserverClass } from '../../dist-electron/shared/frame-resize-observer.js'

function harness(callback) {
  let nextFrame = 1
  const frames = new Map()
  class FakeNativeResizeObserver {
    static last
    constructor(nativeCallback) {
      this.nativeCallback = nativeCallback
      FakeNativeResizeObserver.last = this
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    emit(entries) { this.nativeCallback(entries, this) }
  }
  const FrameResizeObserver = createFrameResizeObserverClass(
    FakeNativeResizeObserver,
    (scheduled) => { const id = nextFrame++; frames.set(id, scheduled); return id },
    (id) => frames.delete(id),
  )
  const observer = new FrameResizeObserver(callback)
  const flush = () => {
    const scheduled = [...frames.values()]
    frames.clear()
    for (const run of scheduled) run()
  }
  return { observer, native: FakeNativeResizeObserver.last, frames, flush }
}

test('frame ResizeObserver merges the latest entry per observed target without dropping targets', () => {
  const deliveries = []
  const { observer, native, frames, flush } = harness((entries, instance) => deliveries.push({ entries, instance }))
  const a = {}; const b = {}
  observer.observe(a); observer.observe(b)
  native.emit([{ target: a, value: 1 }])
  native.emit([{ target: b, value: 2 }, { target: a, value: 3 }])
  assert.equal(frames.size, 1)
  flush()
  assert.deepEqual(deliveries[0].entries.map((entry) => [entry.target, entry.value]), [[a, 3], [b, 2]])
  assert.equal(deliveries[0].instance, observer)
})

test('unobserve and disconnect prevent stale queued callbacks', () => {
  const deliveries = []
  const { observer, native, frames, flush } = harness((entries) => deliveries.push(entries))
  const a = {}; const b = {}
  observer.observe(a); observer.observe(b)
  native.emit([{ target: a }, { target: b }])
  observer.unobserve(a)
  flush()
  assert.deepEqual(deliveries, [[{ target: b }]])
  native.emit([{ target: b }])
  observer.disconnect()
  assert.equal(frames.size, 0)
  flush()
  assert.equal(deliveries.length, 1)

  const sole = harness(() => deliveries.push('stale'))
  const only = {}
  sole.observer.observe(only)
  sole.native.emit([{ target: only }])
  sole.observer.unobserve(only)
  assert.equal(sole.frames.size, 0)
  sole.flush()
  assert.equal(deliveries.length, 1)
})

test('callback exceptions propagate', () => {
  const boom = harness(() => { throw new Error('observer callback failed') })
  const target = {}
  boom.observer.observe(target)
  boom.native.emit([{ target }])
  assert.throws(() => boom.flush(), /observer callback failed/)
})
