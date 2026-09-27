import assert from 'node:assert/strict'
import test from 'node:test'
import { councilInlineContext } from '../../dist-electron/electron/runtime/workflows/planCouncil.js'
import { activationPreamble } from '../../dist-electron/electron/runtime/contextChannel.js'

test('Council inlines complete current peer evidence while preserving independent proposals and excluding superseded results', () => {
  const contents = { own: 'OWN_PROPOSAL', peer: 'PEER_PROPOSAL', obsolete: 'OBSOLETE_PROPOSAL', review: 'PEER_REVIEW' }
  const host = { channelStore: { readArtifact: (id) => contents[id] } }
  const council = {
    participants: { a: { label: 'A' }, b: { label: 'B' } }, supersededArtifactIds: ['obsolete'],
    artifacts: [
      { artifactId: 'own', authorSessionId: 'a', kind: 'proposal', contentRef: 'own' },
      { artifactId: 'peer', authorSessionId: 'b', kind: 'proposal', contentRef: 'peer' },
      { artifactId: 'obsolete', authorSessionId: 'b', kind: 'proposal', contentRef: 'obsolete' },
      { artifactId: 'review', authorSessionId: 'b', kind: 'peer-review', contentRef: 'review' },
    ],
  }
  assert.equal(councilInlineContext(host, council, { sessionId: 'a' }, 'proposal').text, '')
  const peerEvidence = councilInlineContext(host, council, { sessionId: 'a' }, 'peer-review')
  const peerContext = peerEvidence.text
  assert.deepEqual(peerEvidence.inlineDeliveryTopics, ['proposal:b'])
  assert.ok(peerContext.includes('PEER_PROPOSAL'))
  assert.ok(!peerContext.includes('OWN_PROPOSAL'))
  assert.ok(!peerContext.includes('OBSOLETE_PROPOSAL'))
  assert.ok(!peerContext.includes('PEER_REVIEW'))
  const synthesis = councilInlineContext(host, council, { sessionId: 's' }, 'synthesis').text
  assert.ok(synthesis.includes('OWN_PROPOSAL') && synthesis.includes('PEER_PROPOSAL') && synthesis.includes('PEER_REVIEW'))
  assert.ok(!synthesis.includes('OBSOLETE_PROPOSAL'))
})

test('Council never silently truncates large evidence and bounds inline context in bytes', () => {
  const contents = { large: '界'.repeat(30000), small: 'Complete small evidence.' }
  const host = { channelStore: { readArtifact: (id) => contents[id] } }
  const council = { participants: {}, artifacts: Object.keys(contents).map((id) => ({ artifactId: id, authorSessionId: id, kind: 'proposal', contentRef: id })) }
  const evidence = councilInlineContext(host, council, { sessionId: 's' }, 'synthesis')
  const context = evidence.text
  assert.deepEqual(evidence.inlineDeliveryTopics, ['proposal:small'])
  assert.ok(!context.includes('界'))
  assert.ok(context.includes(contents.small))
  assert.match(context, /1 larger source\(s\).*exact paths/)
  assert.ok(Buffer.byteLength(context, 'utf8') < 65536)
})

test('activation reads only deferred files and never contradicts complete inline delivery', () => {
  const current = [
    { seq: 1, from: 'a', topic: 'proposal:a', files: ['/channel/a.md'] },
    { seq: 2, from: 'b', topic: 'proposal:b', files: ['/channel/b.md'] },
  ]
  const complete = activationPreamble({ current, superseded: [] }, { channelDir: '/channel', inlineDeliveryTopics: ['proposal:a', 'proposal:b'] })
  assert.match(complete, /All deliveries are included inline/)
  assert.ok(!complete.includes('/channel'))
  const partial = activationPreamble({ current, superseded: [] }, { channelDir: '/channel', inlineDeliveryTopics: ['proposal:a'] })
  assert.ok(!partial.includes('/channel/a.md'))
  assert.ok(partial.includes('/channel/b.md'))
  assert.match(partial, /Read only the delivered files explicitly listed/)
})

test('a deferred current version never inherits the inline marker of an older version on the same topic', () => {
  const host = { channelStore: { readArtifact: (id) => id === 'old' ? 'old version' : '界'.repeat(30000) } }
  const council = { participants: {}, artifacts: ['old', 'new'].map((id) => ({ artifactId: id, kind: 'proposal', authorSessionId: 'a', contentRef: id })) }
  const result = councilInlineContext(host, council, { sessionId: 's' }, 'synthesis')
  assert.deepEqual(result.inlineDeliveryTopics, [])
  assert.ok(!result.text.includes('old version'))
  assert.match(result.text, /1 larger source/)
})
