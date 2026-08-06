import assert from 'node:assert/strict'
import test from 'node:test'

import { createLatestRequestGate } from '../../dist-electron/shared/latest-request-gate.js'

test('latest request gate rejects an older completion after a newer request starts', async () => {
  const gate = createLatestRequestGate()
  const committed = []
  const oldRequest = gate.begin('codex')
  const oldCompletion = new Promise((resolve) => {
    setTimeout(() => {
      if (gate.isCurrent(oldRequest)) committed.push('old failure')
      resolve()
    }, 20)
  })

  const newRequest = gate.begin('codex')
  if (gate.isCurrent(newRequest)) committed.push('new success')
  await oldCompletion

  assert.deepEqual(committed, ['new success'])
  assert.equal(gate.isCurrent(oldRequest), false)
  assert.equal(gate.isCurrent(newRequest), true)
})

test('latest request gates different providers independently', () => {
  const gate = createLatestRequestGate()
  const codex = gate.begin('codex')
  const claude = gate.begin('claude-code')
  gate.begin('codex')

  assert.equal(gate.isCurrent(codex), false)
  assert.equal(gate.isCurrent(claude), true)
})
