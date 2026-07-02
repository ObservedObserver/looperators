export function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function compactPath(value: string) {
  const withHome = value.replace(/^\/Users\/[^/]+/, '~');
  if (withHome.length <= 48) {
    return withHome;
  }

  const parts = withHome.split('/').filter(Boolean);
  const tail = parts.slice(-2).join('/');
  if (withHome.startsWith('~/')) {
    return `~/.../${tail}`;
  }
  if (withHome.startsWith('/')) {
    return `/.../${tail}`;
  }
  return `.../${tail}`;
}

export function compactId(value: string) {
  return value.length > 12 ? value.slice(0, 8) : value;
}

export function parseTimestamp(value?: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function formatTimestamp(value?: string) {
  const date = parseTimestamp(value);
  if (!date) {
    return value ?? 'unknown';
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function formatClock(value?: string) {
  const date = parseTimestamp(value);
  if (!date) {
    return value?.slice(11, 16) ?? 'unknown';
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatClockSeconds(value?: string) {
  const date = parseTimestamp(value);
  if (!date) {
    return value?.slice(11, 19) ?? 'unknown';
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatRelativeTime(value?: string) {
  const date = parseTimestamp(value);
  if (!date) {
    return value ?? 'unknown';
  }
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

// Auto-generated labels ("New Chat 3", "Claude 2", …) carry no identity; derive
// a display title from the first user message instead. Explicit labels win.

export function firstContentLine(value?: string) {
  return value
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}
