import fs from 'node:fs'
import path from 'node:path'

const outputRoot = path.resolve('dist-electron')

function mapsUnder(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return mapsUnder(entryPath)
    return entry.name.endsWith('.js.map') ? [entryPath] : []
  })
}

for (const mapPath of mapsUnder(outputRoot)) {
  let sourcePaths
  try {
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'))
    sourcePaths = Array.isArray(map.sources)
      ? map.sources.map((source) => path.resolve(path.dirname(mapPath), source))
      : []
  } catch {
    continue
  }
  if (sourcePaths.length === 0 || sourcePaths.some((source) => fs.existsSync(source))) {
    continue
  }

  const jsPath = mapPath.slice(0, -'.map'.length)
  const basePath = jsPath.slice(0, -'.js'.length)
  for (const artifact of [mapPath, jsPath, `${basePath}.d.ts`, `${basePath}.d.ts.map`]) {
    fs.rmSync(artifact, { force: true })
  }
}
