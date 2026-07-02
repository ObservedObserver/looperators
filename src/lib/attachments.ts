import {
  type ChatAttachment,
  chatAttachmentImageMaxBytes,
  chatAttachmentTextMaxLength,
  isSupportedChatAttachmentImageMimeType,
} from '@/shared/provider-runtime';

export const attachmentTextPreviewLimit = chatAttachmentTextMaxLength;

export function createAttachmentId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function fileLooksText(file: File) {
  if (file.type.startsWith('text/')) {
    return true;
  }

  return /\.(c|cc|cpp|css|csv|go|h|html|java|js|json|jsx|log|md|mjs|py|rs|sh|sql|ts|tsx|txt|xml|yaml|yml)$/i.test(file.name);
}

export function readBlobAsText(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'));
    reader.readAsText(blob);
  });
}

export function readBlobAsDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image.'));
    reader.readAsDataURL(blob);
  });
}

export async function composerAttachmentFromFile(file: File): Promise<ChatAttachment> {
  const canUseNativeImage = file.type.startsWith('image/') && isSupportedChatAttachmentImageMimeType(file.type) && file.size <= chatAttachmentImageMaxBytes;
  const kind = canUseNativeImage ? 'image' : fileLooksText(file) ? 'text' : 'binary';
  const attachment: ChatAttachment = {
    id: createAttachmentId(),
    name: file.name || (kind === 'image' ? 'pasted-image.png' : 'attachment'),
    mediaType: file.type || 'application/octet-stream',
    size: file.size,
    kind,
  };

  if (kind === 'image') {
    return {
      ...attachment,
      dataUrl: await readBlobAsDataUrl(file),
    };
  }

  if (kind === 'text') {
    const slice = file.slice(0, attachmentTextPreviewLimit);
    return {
      ...attachment,
      text: await readBlobAsText(slice),
      truncated: file.size > attachmentTextPreviewLimit,
    };
  }

  return attachment;
}

export function insertPlainTextAtCaret(text: string) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

// Terminal status marker (gutter glyph) for a session row.
