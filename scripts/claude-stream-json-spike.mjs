import { spawn } from 'node:child_process'

const mode = process.argv[2] ?? 'finish'
const prompt =
  mode === 'kill'
    ? 'Reply with START, then count upward slowly until stopped.'
    : 'Reply with exactly: ok'

const child = spawn(
  'claude',
  ['-p', prompt, '--output-format=stream-json', '--verbose'],
  {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
)

let sawJson = false
let sawResult = false
let killTimer
let killFallbackTimer

function requestKill() {
  if (child.killed) {
    return
  }

  console.log('[spike] sending SIGTERM')
  child.kill('SIGTERM')
}

child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')

child.stdout.on('data', (data) => {
  for (const line of data.split('\n')) {
    if (line.trim().length === 0) {
      continue
    }

    const event = JSON.parse(line)
    sawJson = true
    console.log(`[stdout:${event.type}] ${line}`)
    if (event.type === 'result') {
      sawResult = true
    }
    if (mode === 'kill' && !killTimer) {
      killTimer = setTimeout(requestKill, 250)
    }
  }
})

child.stderr.on('data', (data) => {
  process.stderr.write(data)
})

if (mode === 'kill') {
  killFallbackTimer = setTimeout(requestKill, 8000)
}

child.on('close', (code, signal) => {
  if (killTimer) {
    clearTimeout(killTimer)
  }
  if (killFallbackTimer) {
    clearTimeout(killFallbackTimer)
  }

  console.log(
    `[spike] closed code=${code ?? 'null'} signal=${signal ?? 'null'} sawJson=${sawJson} sawResult=${sawResult}`
  )

  if (mode === 'kill') {
    process.exit((signal || code !== 0) && sawJson && !sawResult ? 0 : 1)
  }

  process.exit(code === 0 && sawResult ? 0 : 1)
})
