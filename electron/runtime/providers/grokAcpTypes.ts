export type GrokAcpId = number | string

export type GrokAcpError = {
  code?: number
  message?: string
  data?: unknown
  [key: string]: unknown
}

export type GrokAcpMessage = {
  jsonrpc?: string
  id?: GrokAcpId
  method?: string
  params?: any
  result?: any
  error?: GrokAcpError
  [key: string]: unknown
}

export type GrokAcpSessionUpdate = {
  sessionUpdate?: string
  toolCallId?: string
  title?: string
  kind?: string
  status?: string
  content?: any
  entries?: any[]
  rawInput?: unknown
  rawOutput?: unknown
  _meta?: Record<string, unknown>
  [key: string]: unknown
}

export type GrokAcpProviderInstance = {
  providerInstanceId?: string
  kind?: string
  label?: string
  binaryPath?: string
  launchArgs?: string[]
  env?: Record<string, string>
}
