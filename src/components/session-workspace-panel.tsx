import { AlertCircle, File, Folder, FolderTree, PanelRightClose, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { compactPath } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { RuntimeApi } from '@/runtime-client';
import type { WorkspaceFileContentResult, WorkspaceFileEntry, WorkspaceFilesResult } from '@/shared/graph-state';

type SessionWorkspacePanelProps = {
  sessionId: string;
  cwd: string;
  runtimeApi?: RuntimeApi;
  onClose: () => void;
};

function formatFileCount(result: WorkspaceFilesResult | undefined) {
  if (!result) {
    return '...';
  }
  return `${result.totalFiles.toLocaleString()}${result.truncated ? '+' : ''}`;
}

function formatFileSize(size: number | undefined) {
  if (size === undefined) {
    return undefined;
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function WorkspaceEntryRow({
  entry,
  depth,
  selectedPath,
  onSelectFile,
}: {
  entry: WorkspaceFileEntry;
  depth: number;
  selectedPath?: string;
  onSelectFile: (path: string) => void;
}) {
  const isDirectory = entry.kind === 'directory';
  const isSelectableFile = entry.kind === 'file';
  const isSelected = selectedPath === entry.path;
  const sizeLabel = formatFileSize(entry.size);
  const rowClassName = cn(
    'grid min-h-7 w-full grid-cols-[1fr_auto] items-center gap-2 border-b border-ink-line-2 px-2 text-left text-[12px] last:border-b-0',
    isSelectableFile ? 'hover:bg-ink-soft' : 'cursor-default',
    isSelected && 'bg-lime/[0.08] text-term-name',
  );
  const content = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        {isDirectory ? <Folder className="size-3.5 shrink-0 text-term-cyan" /> : <File className="size-3.5 shrink-0 text-term-dim2" />}
        <span className={cn('min-w-0 truncate font-mono', isDirectory ? 'text-term-name' : 'text-term-dim', isSelected && 'text-term-name')} title={entry.path}>
          {entry.name}
        </span>
      </div>
      {sizeLabel ? <span className="font-mono text-[10.5px] tabular-nums text-term-faint">{sizeLabel}</span> : null}
    </>
  );

  return (
    <>
      {isSelectableFile ? (
        <button type="button" className={rowClassName} style={{ paddingLeft: `${8 + depth * 14}px` }} onClick={() => onSelectFile(entry.path)}>
          {content}
        </button>
      ) : (
        <div className={rowClassName} style={{ paddingLeft: `${8 + depth * 14}px` }}>
          {content}
        </div>
      )}
      {entry.children?.map((child) => (
        <WorkspaceEntryRow key={child.path} entry={child} depth={depth + 1} selectedPath={selectedPath} onSelectFile={onSelectFile} />
      ))}
    </>
  );
}

function WorkspaceFilePreview({
  selectedPath,
  content,
  isLoading,
  error,
}: {
  selectedPath?: string;
  content?: WorkspaceFileContentResult;
  isLoading: boolean;
  error?: string;
}) {
  if (!selectedPath) {
    return <div className="m-3 rounded-md border border-dashed border-ink-line p-4 text-center font-mono text-[12px] text-term-dim2">Select a file.</div>;
  }

  if (error) {
    return (
      <div className="m-3 flex items-start gap-2 rounded-md border border-term-amber/35 bg-term-amber/10 px-3 py-2 font-mono text-[11px] leading-4 text-term-amber">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{error}</span>
      </div>
    );
  }

  if (isLoading && !content) {
    return <div className="m-3 rounded-md border border-ink-line p-4 font-mono text-[12px] text-term-dim2">Loading file...</div>;
  }

  if (!content) {
    return null;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-ink-line px-3 py-2 font-mono">
        <div className="truncate text-[12px] text-term-name" title={content.path}>
          {content.path}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10.5px] text-term-faint">
          <span>{formatFileSize(content.size)}</span>
          {content.truncated ? <span className="text-term-amber">truncated</span> : null}
          {content.isBinary ? <span className="text-term-amber">binary</span> : null}
        </div>
      </div>

      {content.isBinary ? (
        <div className="m-3 rounded-md border border-dashed border-ink-line p-4 text-center font-mono text-[12px] text-term-dim2">
          Binary file preview unavailable.
        </div>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto bg-ink px-3 py-2 font-mono text-[11px] leading-5 text-term-dim">
          {content.content.length > 0 ? content.content : ' '}
        </pre>
      )}
    </div>
  );
}

export function SessionWorkspacePanel({ sessionId, cwd, runtimeApi, onClose }: SessionWorkspacePanelProps) {
  const [result, setResult] = useState<WorkspaceFilesResult>();
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [fileContent, setFileContent] = useState<WorkspaceFileContentResult>();
  const [fileError, setFileError] = useState<string>();
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const fileRequestSeq = useRef(0);

  const loadWorkspaceFile = useCallback(
    async (path: string) => {
      const requestSeq = fileRequestSeq.current + 1;
      fileRequestSeq.current = requestSeq;
      setSelectedPath(path);
      setFileContent(undefined);
      setFileError(undefined);

      if (!runtimeApi) {
        setFileError('Runtime unavailable.');
        return;
      }

      setIsLoadingFile(true);
      try {
        const nextContent = await runtimeApi.getWorkspaceFileContent({
          sessionId,
          path,
        });
        if (fileRequestSeq.current === requestSeq) {
          setFileContent(nextContent);
        }
      } catch (loadError) {
        if (fileRequestSeq.current === requestSeq) {
          setFileError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (fileRequestSeq.current === requestSeq) {
          setIsLoadingFile(false);
        }
      }
    },
    [runtimeApi, sessionId],
  );

  const loadWorkspaceFiles = useCallback(async () => {
    if (!runtimeApi) {
      setResult(undefined);
      setError('Runtime unavailable.');
      return;
    }

    setIsLoading(true);
    setError(undefined);
    try {
      const nextResult = await runtimeApi.getWorkspaceFiles({
        sessionId,
        maxDepth: 4,
        maxEntries: 500,
      });
      setResult(nextResult);
    } catch (loadError) {
      setResult(undefined);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIsLoading(false);
    }
  }, [runtimeApi, sessionId]);

  useEffect(() => {
    let canceled = false;
    const load = async () => {
      setSelectedPath(undefined);
      setFileContent(undefined);
      setFileError(undefined);
      fileRequestSeq.current += 1;

      if (!runtimeApi) {
        setResult(undefined);
        setError('Runtime unavailable.');
        return;
      }

      setIsLoading(true);
      setError(undefined);
      try {
        const nextResult = await runtimeApi.getWorkspaceFiles({
          sessionId,
          maxDepth: 4,
          maxEntries: 500,
        });
        if (!canceled) {
          setResult(nextResult);
        }
      } catch (loadError) {
        if (!canceled) {
          setResult(undefined);
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!canceled) {
          setIsLoading(false);
        }
      }
    };

    void load();
    return () => {
      canceled = true;
    };
  }, [cwd, runtimeApi, sessionId]);

  return (
    <aside className="flex h-full w-[min(640px,calc(100vw-8px))] min-w-0 shrink-0 flex-col border-l border-border bg-card sm:min-w-[420px]">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <FolderTree className="size-4 shrink-0 text-accent-ink" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Workspace</span>
            <span className="ml-auto font-mono text-[10.5px] tabular-nums text-muted-foreground">{formatFileCount(result)} files</span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground" title={cwd}>
            {compactPath(cwd)}
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              className="size-7 shrink-0"
              variant="ghost"
              size="icon"
              aria-label="Refresh workspace files"
              disabled={isLoading}
              onClick={loadWorkspaceFiles}
            >
              <RefreshCw className={cn('size-3.5', isLoading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh workspace files</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button className="size-7 shrink-0" variant="ghost" size="icon" aria-label="Close workspace" onClick={onClose}>
              <PanelRightClose className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close workspace</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex min-h-0 flex-1 bg-ink">
        <div className="min-h-0 w-[42%] min-w-40 max-w-56 shrink-0 overflow-y-auto border-r border-ink-line bg-ink">
          {error ? (
            <div className="m-3 flex items-start gap-2 rounded-md border border-term-amber/35 bg-term-amber/10 px-3 py-2 font-mono text-[11px] leading-4 text-term-amber">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          ) : result?.entries.length ? (
            <div className="min-w-0">
              {result.entries.map((entry) => (
                <WorkspaceEntryRow key={entry.path} entry={entry} depth={0} selectedPath={selectedPath} onSelectFile={loadWorkspaceFile} />
              ))}
            </div>
          ) : (
            <div className="m-3 rounded-md border border-dashed border-ink-line p-4 text-center font-mono text-[12px] text-term-dim2">
              {isLoading ? 'Loading workspace...' : 'No files found.'}
            </div>
          )}
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-ink">
          <WorkspaceFilePreview selectedPath={selectedPath} content={fileContent} isLoading={isLoadingFile} error={fileError} />
        </div>
      </div>
    </aside>
  );
}
