import { type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, useCallback, useEffect, useRef, useState } from 'react';

import type { ChatAttachment } from '@/shared/provider-runtime';
import { composerAttachmentFromFile, insertPlainTextAtCaret } from '@/lib/attachments';

export function useComposer({ setRuntimeError }: { setRuntimeError: (error: string | undefined) => void }) {
  const [message, setMessage] = useState('');
  const [composerAttachments, setComposerAttachments] = useState<ChatAttachment[]>([]);
  const [isComposerDragActive, setIsComposerDragActive] = useState(false);
  const composerEditorRef = useRef<HTMLDivElement | null>(null);
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);

  const setComposerText = useCallback((text: string) => {
    setMessage(text);
    if (composerEditorRef.current) {
      composerEditorRef.current.textContent = text;
    }
  }, []);

  const clearComposer = useCallback(() => {
    setComposerText('');
    setComposerAttachments([]);
  }, [setComposerText]);

  const addComposerFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileList = Array.from(files).filter((file) => file.size >= 0);
      if (fileList.length === 0) {
        return;
      }

      const results = await Promise.allSettled(fileList.map((file) => composerAttachmentFromFile(file)));
      const attachments = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
      const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');

      if (attachments.length > 0) {
        setComposerAttachments((current) => [...current, ...attachments]);
      }
      if (firstError) {
        setRuntimeError(firstError.reason instanceof Error ? firstError.reason.message : String(firstError.reason));
      }
    },
    [setRuntimeError],
  );

  const removeComposerAttachment = useCallback((id: string) => {
    setComposerAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }, []);

  const handleComposerPaste = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      const files = Array.from(event.clipboardData.files).filter((file) => file.size > 0 || file.type.startsWith('image/'));
      if (files.length > 0) {
        event.preventDefault();
        void addComposerFiles(files);
        return;
      }

      const text = event.clipboardData.getData('text/plain');
      if (text.length > 0) {
        event.preventDefault();
        if (insertPlainTextAtCaret(text)) {
          setMessage(event.currentTarget.innerText);
        }
      }
    },
    [addComposerFiles],
  );

  const handleComposerDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      setIsComposerDragActive(false);
      void addComposerFiles(files);
    },
    [addComposerFiles],
  );

  useEffect(() => {
    const editor = composerEditorRef.current;
    if (!editor) {
      return;
    }

    if (message.length === 0 || (typeof document !== 'undefined' && document.activeElement !== editor)) {
      if (editor.textContent !== message) {
        editor.textContent = message;
      }
    }
  }, [message]);

  const composerHasPayload = message.trim().length > 0 || composerAttachments.length > 0;

  return {
    message,
    setMessage,
    composerAttachments,
    isComposerDragActive,
    setIsComposerDragActive,
    composerEditorRef,
    composerFileInputRef,
    setComposerText,
    clearComposer,
    addComposerFiles,
    removeComposerAttachment,
    handleComposerPaste,
    handleComposerDrop,
    composerHasPayload,
  };
}

export type ComposerState = ReturnType<typeof useComposer>;
