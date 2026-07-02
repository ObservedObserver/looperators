import type { RuntimeActivity } from './provider-runtime';

/**
 * Converts normalized runtime activity items into the terminal tool-call feed.
 * Provider-specific raw stream parsing belongs in runtime mappers, not the UI.
 */

export type ToolRunStatus = 'running' | 'ok' | 'error';

export type ToolSubline = {
  key?: string;
  value: string;
};

export type ToolRun = {
  /** tool_use id (`toolu_…`). */
  id: string;
  /** raw Claude tool name (`Read`, `Bash`, `mcp__orrery_membrane__report`). */
  name: string;
  /** terminalized command label (`read_file`, `bash`, `membrane.report`). */
  command: string;
  /** short argument summary shown after the command. */
  args?: string;
  /** optional detail lines parsed from the tool result. */
  sublines: ToolSubline[];
  status: ToolRunStatus;
  durationMs?: number;
};

/** One provider turn worth of tool activity. */
export type ToolTurn = {
  turnId?: string;
  toolRuns: ToolRun[];
};

function basename(value: string): string {
  const cleaned = value.split(/[?#]/)[0].replace(/\/+$/, '');
  const parts = cleaned.split('/');
  return parts[parts.length - 1] || cleaned;
}

function hostname(value: string): string {
  const match = /^[a-z]+:\/\/([^/]+)/i.exec(value);
  return match ? match[1].replace(/^www\./, '') : value;
}

function clamp(value: string, max = 52): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Maps a Claude tool name to a terminal-style command label. */
export function toolCommand(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    const server = (parts[1] ?? '').replace(/^orrery_/, '');
    const tool = parts.slice(2).join('_') || parts[1] || name;
    return server ? `${server}.${tool}` : tool;
  }
  switch (name) {
    case 'Read':
      return 'read_file';
    case 'Edit':
    case 'MultiEdit':
      return 'apply_patch';
    case 'Write':
      return 'write_file';
    case 'NotebookEdit':
      return 'notebook_edit';
    case 'Bash':
      return 'bash';
    case 'BashOutput':
      return 'bash_output';
    case 'Grep':
      return 'grep';
    case 'Glob':
      return 'glob';
    case 'Task':
      return 'task';
    case 'WebFetch':
      return 'web.fetch';
    case 'WebSearch':
      return 'web.search';
    case 'TodoWrite':
      return 'todo_write';
    default:
      return name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[\s-]+/g, '_')
        .toLowerCase();
  }
}

/** Extracts a short argument summary from a tool's input. */
export function toolArgs(name: string, input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') {
    return undefined;
  }
  const obj = input as Record<string, unknown>;

  if (name === 'Read' || name === 'Write' || name === 'NotebookEdit') {
    const file = asString(obj.file_path ?? obj.notebook_path ?? obj.path);
    return file ? basename(file) : undefined;
  }
  if (name === 'Edit' || name === 'MultiEdit') {
    const file = asString(obj.file_path);
    return file ? basename(file) : undefined;
  }
  if (name === 'Bash') {
    const cmd = asString(obj.command);
    return cmd ? clamp(cmd, 56) : undefined;
  }
  if (name === 'Grep') {
    const pattern = asString(obj.pattern);
    const path = asString(obj.path);
    const where = path ? ` ${basename(path)}` : '';
    return pattern ? clamp(`"${pattern}"${where}`) : undefined;
  }
  if (name === 'Glob') {
    return asString(obj.pattern);
  }
  if (name === 'Task') {
    return clamp(asString(obj.description ?? obj.prompt) ?? '');
  }
  if (name === 'WebFetch') {
    const url = asString(obj.url);
    return url ? hostname(url) : undefined;
  }
  if (name === 'WebSearch') {
    return clamp(asString(obj.query) ?? '');
  }
  if (name === 'TodoWrite') {
    const todos = obj.todos;
    return Array.isArray(todos) ? `${todos.length} items` : undefined;
  }
  if (name.startsWith('mcp__')) {
    const label = asString(obj.label) ?? asString(obj.verdict) ?? asString(obj.type) ?? asString(obj.agent) ?? asString(obj.sessionId);
    return label ? clamp(label, 40) : undefined;
  }

  // Generic: first short string field.
  for (const value of Object.values(obj)) {
    if (typeof value === 'string' && value.length > 0) {
      return clamp(value);
    }
  }
  return undefined;
}

/** Formats a duration for display (`40ms`, `1.2s`). */
export function formatDuration(ms?: number): string | undefined {
  if (ms === undefined) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function activityStatus(status: RuntimeActivity['status']): ToolRunStatus {
  if (status === 'completed') {
    return 'ok';
  }
  if (status === 'failed') {
    return 'error';
  }
  return 'running';
}

function isToolRunActivity(activity: RuntimeActivity) {
  return activity.kind === 'tool_call' || activity.kind === 'command' || activity.kind === 'file_change';
}

export function toolTurnsFromRuntimeActivities(activities: RuntimeActivity[]): Map<string, ToolTurn> {
  const turns = new Map<string, ToolTurn>();

  for (const activity of activities) {
    if (!activity.turnId || !isToolRunActivity(activity)) {
      continue;
    }

    const turn = turns.get(activity.turnId) ?? {
      turnId: activity.turnId,
      toolRuns: [],
    };
    const existing = turn.toolRuns.find((run) => run.id === activity.id);
    const run: ToolRun = {
      id: activity.id,
      name: activity.providerName ?? activity.title,
      command: activity.command ?? toolCommand(activity.providerName ?? activity.title),
      args: activity.args,
      sublines: activity.sublines ?? [],
      status: activityStatus(activity.status),
      durationMs: activity.durationMs,
    };

    if (existing) {
      Object.assign(existing, run);
    } else {
      turn.toolRuns.push(run);
    }

    turns.set(activity.turnId, turn);
  }

  return turns;
}
