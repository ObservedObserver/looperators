import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { defaultScopeWorkflowCapability } from '../../dist-electron/shared/workflow-authoring.js'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-workflow-preview-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
function transpile(sourcePath, target, replacements = {}) {
  let source = fs.readFileSync(sourcePath, 'utf8')
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(from, to)
  fs.writeFileSync(path.join(tempRoot, target), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2023, verbatimModuleSyntax: true },
  }).outputText)
}
transpile('src/shared/provider-runtime.ts', 'provider-runtime.mjs')
transpile('src/lib/workflow-authoring.ts', 'workflow-authoring.mjs', {
  '@/shared/provider-runtime': './provider-runtime.mjs',
  '@shared/workflow-authoring': pathToFileURL(path.resolve('dist-electron/shared/workflow-authoring.js')).href,
})
const { previewPlanCouncilWorkflow, authorAndCommitWorkflow } = await import(pathToFileURL(path.join(tempRoot, 'workflow-authoring.mjs')).href)
const at = '2026-09-27T00:00:00.000Z'
const runtimeSettings = { runtimeMode: 'approval-required', sandbox: 'read-only', interactionMode: 'plan' }
const agent = (key) => ({ key, label: key, providerKind: 'codex', providerInstanceId: 'codex-default', runtimeSettings })
const input = { objective: 'Compare approaches', cwd: '/tmp/project', planners: [agent('a'), agent('b')], synthesizer: agent('c') }
const state = (count) => ({
  updatedAt: at,
  providerInstances: [{ providerInstanceId: 'codex-default', kind: 'codex' }],
  sessions: Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), {
    sessionId: String(i), label: `Session ${i}`, cwd: '/tmp/other-project', status: 'idle', archived: true,
    providerKind: 'codex', providerInstanceId: 'codex-default',
  }])),
})

test('cold comparison preview uses the default global cap and counts archived sessions in other projects', () => {
  const snapshot = state(6)
  const before = structuredClone(snapshot)
  const preview = previewPlanCouncilWorkflow(snapshot, input)
  assert.equal(preview.existingSessionCount, 6)
  assert.equal(preview.newSessionCount, 3)
  assert.equal(preview.sessionLimit, 8)
  assert.equal(preview.validation.estimatedSessionCount, 9)
  assert.ok(preview.validation.errors.some((issue) => issue.code === 'session-limit'))
  assert.deepEqual(snapshot, before, 'preview must not persist a capability or create sessions')
})

test('cold comparison preview respects persisted capacity and the exact allowed boundary', () => {
  const snapshot = state(6)
  snapshot.workflowCapabilities = { global: defaultScopeWorkflowCapability('global', ['codex-default'], at) }
  snapshot.workflowCapabilities.global.policy.maxSessions = 9
  assert.deepEqual(previewPlanCouncilWorkflow(snapshot, input).validation.errors, [])
  snapshot.workflowCapabilities.global.policy.maxSessions = 7
  assert.ok(previewPlanCouncilWorkflow(snapshot, input).validation.errors.some((issue) => issue.code === 'session-limit'))
  assert.deepEqual(previewPlanCouncilWorkflow(state(5), input).validation.errors, [])
})

test('invalid authoritative proposal stops before approval and commit', async () => {
  const calls = []
  const api = { async dispatchCommand(command) {
    calls.push(command.kind)
    return { proposal: { baseVersion: 0, validation: { errors: [{ message: 'Scope capacity changed.' }] } } }
  } }
  await assert.rejects(authorAndCommitWorkflow(api, { recipe: 'plan-council', objective: input.objective, recipeInput: input, reason: 'unit test' }), /Scope capacity changed/)
  assert.deepEqual(calls, ['propose_workflow'])
})

test('valid authoritative proposal preserves approval and commit order', async () => {
  const calls = []
  const api = { async dispatchCommand(command) {
    calls.push(command)
    return { proposal: { baseVersion: 2, validation: { errors: [] } } }
  } }
  await authorAndCommitWorkflow(api, { recipe: 'plan-council', objective: input.objective, recipeInput: input, reason: 'unit test' })
  assert.deepEqual(calls.map((command) => command.kind), ['propose_workflow', 'approve_workflow_proposal', 'commit_workflow'])
  assert.equal(calls[2].input.expectedBaseVersion, 2)
})
