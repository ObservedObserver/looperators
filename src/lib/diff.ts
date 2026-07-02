import {
  type WorkingTreeDiffResult,
} from '@/shared/graph-state'

export function diffPatchLineClassName(line: string) {
  if (line.startsWith('diff --git') || line.startsWith('index ')) {
    return 'text-term-cyan'
  }
  if (line.startsWith('@@')) {
    return 'bg-term-cyan/10 text-term-cyan'
  }
  if (line.startsWith('+++') || line.startsWith('---')) {
    return 'text-term-dim'
  }
  if (line.startsWith('+')) {
    return 'bg-term-green/10 text-term-green'
  }
  if (line.startsWith('-')) {
    return 'bg-term-rose/10 text-term-rose'
  }
  return 'text-term-dim'
}

export function diffRangeLabel(diff: WorkingTreeDiffResult) {
  if (diff.range.kind === 'working-tree') {
    return `${diff.range.base} -> ${diff.range.target}`
  }

  const from =
    diff.range.fromTurnCount !== undefined
      ? `turn ${diff.range.fromTurnCount}`
      : diff.range.fromCheckpointRef
  const to =
    diff.range.toTurnCount !== undefined
      ? `turn ${diff.range.toTurnCount}`
      : diff.range.toCheckpointRef
  return `${from} -> ${to}`
}
