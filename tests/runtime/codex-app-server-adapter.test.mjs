import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { codexInputItemsForTest } from '../../dist-electron/electron/runtime/providers/codexAppServerAdapter.js'
import { CodexJsonRpcClient } from '../../dist-electron/electron/runtime/providers/codexJsonRpcClient.js'

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

test('Codex JSON-RPC client launches through provider instance settings', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-codex-client-'))
  const fakeCodex = path.join(tempRoot, 'codex')
  const markerFile = path.join(tempRoot, 'launch.json')
  const homePath = path.join(tempRoot, 'codex-home')
  const shadowHomePath = path.join(tempRoot, 'codex-shadow')

  fs.writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify({
  argv: process.argv.slice(2),
  codexHome: process.env.CODEX_HOME,
  sharedHome: process.env.ORRERY_CODEX_SHARED_HOME,
  custom: process.env.ORRERY_CODEX_TEST
}))
setTimeout(() => process.exit(0), 25)
`
  )
  fs.chmodSync(fakeCodex, 0o755)

  const client = new CodexJsonRpcClient({
    cwd: tempRoot,
    providerInstance: {
      providerInstanceId: 'default-codex',
      kind: 'codex',
      label: 'Codex Test',
      binaryPath: fakeCodex,
      homePath,
      shadowHomePath,
      launchArgs: ['--profile-flag'],
      env: { ORRERY_CODEX_TEST: 'yes' },
    },
  })

  try {
    await new Promise((resolve) => client.once('close', resolve))
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
    assert.deepEqual(marker.argv, [
      'app-server',
      '--listen',
      'stdio://',
      '--profile-flag',
    ])
    assert.equal(marker.codexHome, shadowHomePath)
    assert.equal(marker.sharedHome, homePath)
    assert.equal(marker.custom, 'yes')
  } finally {
    client.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
