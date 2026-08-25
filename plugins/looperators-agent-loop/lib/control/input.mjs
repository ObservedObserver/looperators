import { assertSafeFileId } from '../contracts.mjs';
import { NATIVE_SUBAGENT_SOURCE, ROOT_METADATA_KEY } from './constants.mjs';
import { fail } from './errors.mjs';

export function boundedString(value, name, max = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail('INVALID_TOOL_INPUT', `${name} is invalid`);
  }
  return value;
}

export function requestId(value) {
  boundedString(value, 'requestId', 128);
  try {
    assertSafeFileId(value, 'requestId');
  } catch {
    fail('INVALID_TOOL_INPUT', 'requestId is invalid');
  }
  if (value.startsWith('internal-')) {
    fail('INVALID_TOOL_INPUT', 'requestId uses a reserved internal namespace');
  }
  return value;
}

export function runId(value) {
  try {
    return assertSafeFileId(value, 'runId');
  } catch {
    fail('INVALID_TOOL_INPUT', 'runId is invalid');
  }
}

export function agentId(value) {
  boundedString(value, 'agentId', 256);
  return value;
}

export function assertRootContext(context) {
  if (!context || typeof context.rootSessionId !== 'string' || typeof context.turnId !== 'string') {
    fail('ROOT_IDENTITY_UNAVAILABLE', 'trusted root task metadata is unavailable');
  }
  return context;
}

export function rootContextFromMcpMessage(message) {
  const metadata = message?.params?._meta?.[ROOT_METADATA_KEY];
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    typeof metadata.session_id !== 'string' ||
    metadata.session_id.length === 0 ||
    metadata.session_id.length > 512 ||
    typeof metadata.turn_id !== 'string' ||
    metadata.turn_id.length === 0 ||
    metadata.turn_id.length > 512 ||
    typeof metadata.thread_source !== 'string' ||
    metadata.thread_source.length === 0 ||
    metadata.thread_source.length > 128
  ) {
    fail('ROOT_IDENTITY_UNAVAILABLE', 'trusted root task metadata is unavailable');
  }
  const rootSessionId = metadata.session_id;
  const turnId = metadata.turn_id;
  const threadSource = metadata.thread_source;
  const nativeAgentId = metadata.agent_id;
  if (nativeAgentId !== undefined && (typeof nativeAgentId !== 'string' || nativeAgentId.length === 0 || nativeAgentId.length > 512)) {
    fail('ROOT_IDENTITY_UNAVAILABLE', 'trusted root task metadata is unavailable');
  }
  if (threadSource === NATIVE_SUBAGENT_SOURCE) {
    fail('ROOT_ONLY_TOOL', 'this tool may only be called by the root task');
  }
  return Object.freeze({ rootSessionId, turnId, threadSource });
}
