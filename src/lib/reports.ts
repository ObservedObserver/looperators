import {
  type Report,
} from '@/shared/graph-state'

export function latestReportForSession(reports: Report[], sessionId: string) {
  return reports
    .filter((report) => report.from === sessionId)
    .sort((left, right) => right.envelope.ts.localeCompare(left.envelope.ts))[0]
}

export function reportTitle(report: Report) {
  if (report.payload.type === 'verdict') {
    return `verdict: ${report.payload.verdict}`
  }

  if (report.payload.type === 'relationship') {
    return `relationship: ${report.payload.target}`
  }

  return 'info'
}

export function reportBody(report: Report) {
  if (report.payload.type === 'verdict') {
    if (report.payload.summary) {
      return report.payload.summary
    }

    if (report.payload.issues?.length) {
      return report.payload.issues
        .map((issue) => issue.file ? `${issue.message} (${issue.file})` : issue.message)
        .join('\n')
    }

    return 'No issues listed.'
  }

  if (report.payload.type === 'relationship') {
    return report.payload.nature ?? report.payload.sessionRef ?? 'relationship'
  }

  return JSON.stringify(report.payload.payload)
}

export function reportIssueCount(report: Report) {
  if (report.payload.type !== 'verdict') {
    return undefined
  }

  return report.payload.issues?.length ?? 0
}

export function reportSummary(report: Report) {
  const body = reportBody(report)
  return body.length > 180 ? `${body.slice(0, 177)}...` : body
}
