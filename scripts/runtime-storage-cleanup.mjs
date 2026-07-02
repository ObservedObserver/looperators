import fs from 'node:fs'
import path from 'node:path'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function storageArtifacts(storageFile) {
  const dir = path.dirname(storageFile)
  const base = path.basename(storageFile)
  // Kernel event store lives next to the JSON snapshot as <stem>.sqlite
  // (plus -wal/-shm and preserved .corrupt.* files).
  const kernelBase = `${base.replace(/\.json$/, '')}.sqlite`

  try {
    return fs
      .readdirSync(dir)
      .filter(
        (name) =>
          name === base ||
          name.startsWith(`${base}.`) ||
          name === kernelBase ||
          name.startsWith(kernelBase)
      )
      .map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

function removeStorageArtifacts(storageFile) {
  for (const filePath of storageArtifacts(storageFile)) {
    fs.rmSync(filePath, { force: true })
  }
}

export async function cleanupRuntimeStorage(runtime, storageFile) {
  runtime.killAll()

  const deadline = Date.now() + 4500
  while (Date.now() < deadline) {
    removeStorageArtifacts(storageFile)
    await sleep(100)
  }

  removeStorageArtifacts(storageFile)
}
