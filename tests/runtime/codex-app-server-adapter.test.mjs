import assert from 'node:assert/strict'
import test from 'node:test'

import { codexInputItemsForTest } from '../../dist-electron/electron/runtime/providers/codexAppServerAdapter.js'

test('Codex app-server input uses provider-native image attachment payloads', () => {
  const dataUrl = 'data:image/png;base64,aW1hZ2U='
  const input = codexInputItemsForTest({
    prompt: 'review image',
    attachments: [
      {
        id: 'image-1',
        name: 'screen.png',
        mediaType: 'image/png',
        size: 5,
        kind: 'image',
        dataUrl,
      },
      {
        id: 'text-1',
        name: 'notes.md',
        mediaType: 'text/markdown',
        size: 7,
        kind: 'text',
        text: '# notes',
      },
      {
        id: 'binary-1',
        name: 'diagram.svg',
        mediaType: 'image/svg+xml',
        size: 12,
        kind: 'binary',
      },
    ],
  })

  assert.deepEqual(input[0], {
    type: 'text',
    text: 'review image',
    text_elements: [],
  })
  assert.deepEqual(input[1], {
    type: 'image',
    url: dataUrl,
  })
  assert.equal(input[2].type, 'text')
  assert.match(input[2].text, /notes\.md/)
  assert.match(input[2].text, /# notes/)
  assert.equal(input[3].type, 'text')
  assert.match(input[3].text, /diagram\.svg/)
  assert.doesNotMatch(input[3].text, /data:image/)
})
