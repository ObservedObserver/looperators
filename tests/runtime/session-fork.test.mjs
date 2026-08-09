import assert from 'node:assert/strict'
import test from 'node:test'

import { createSessionFork } from '../../dist-electron/electron/runtime/sessions/sessionFork.js'

test('session fork rejects managed worktrees before creating shared ownership', () => {
  assert.throws(
    () =>
      createSessionFork(
        { project: { workMode: 'worktree' }, status: 'idle' },
        {},
        { x: 0, y: 0 },
      ),
    /managed-worktree chat/,
  )
})

test('session fork waits for the source chat to become idle', () => {
  assert.throws(
    () =>
      createSessionFork(
        { project: { workMode: 'local' }, status: 'running' },
        {},
        { x: 0, y: 0 },
      ),
    /Wait for the source chat to finish/,
  )
})
