import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
)

function walkFiles(dir) {
  if (!fs.existsSync(dir)) {
    return []
  }

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const absolutePath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        return walkFiles(absolutePath)
      }

      return absolutePath
    })
}

function assertFile(filePath) {
  assert.ok(fs.existsSync(filePath), `Missing expected file: ${filePath}`)
}

const electronSourceFiles = [
  ...walkFiles(path.join(repoRoot, 'electron')),
  ...walkFiles(path.join(repoRoot, 'shared')),
]
const straySourceJs = electronSourceFiles.filter((file) => file.endsWith('.js'))
assert.deepEqual(
  straySourceJs.map((file) => path.relative(repoRoot, file)),
  [],
  'Electron backend source should be TypeScript-only'
)

assert.equal(
  packageJson.main,
  'dist-electron/electron/main.js',
  'Electron main must point at the TypeScript build output'
)

const requiredBuildOutputs = [
  'dist-electron/electron/main.js',
  'dist-electron/electron/preload.js',
  'dist-electron/electron/runtime/sessionManager.js',
  'dist-electron/electron/runtime/membraneMcpServer.js',
  'dist-electron/electron/runtime/providers/codexAppServerAdapter.js',
  'dist-electron/shared/graph-state.js',
  'dist-electron/electron/runtime/sessionManager.d.ts',
]

for (const relativePath of requiredBuildOutputs) {
  assertFile(path.join(repoRoot, relativePath))
}

const mainSource = fs.readFileSync(path.join(repoRoot, 'electron/main.ts'), 'utf8')
assert.match(
  mainSource,
  /app\.getAppPath\(\), 'dist\/index\.html'/,
  'Production renderer path should resolve from app root after Electron TS compilation'
)

const smokeScripts = walkFiles(path.join(repoRoot, 'scripts')).filter(
  (file) =>
    file.endsWith('.mjs') &&
    path.basename(file) !== 'electron-typescript-acceptance.mjs'
)
for (const script of smokeScripts) {
  const source = fs.readFileSync(script, 'utf8')
  assert.ok(
    !source.includes('../electron/runtime/sessionManager.js'),
    `${path.relative(repoRoot, script)} should import the compiled runtime`
  )
}

await import(path.join(repoRoot, 'dist-electron/electron/runtime/sessionManager.js'))

console.log(
  '[acceptance:electron] TypeScript source, compiled Electron entry, declarations, and smoke imports verified'
)
