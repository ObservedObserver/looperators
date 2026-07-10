import { Children, isValidElement, memo, useCallback, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import rehypeSanitize, { defaultSchema, type Options as SanitizeOptions } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type AgentMarkdownProps = {
  text: string;
  streaming?: boolean;
  className?: string;
};

type CodeElementProps = ComponentPropsWithoutRef<'code'> & {
  className?: string;
  children?: ReactNode;
  node?: unknown;
};

type PreElementProps = ComponentPropsWithoutRef<'pre'> & { node?: unknown };
type LinkElementProps = ComponentPropsWithoutRef<'a'> & { node?: unknown };
type TableElementProps = ComponentPropsWithoutRef<'table'> & { node?: unknown };

const markdownFencePattern = /(^|\n)```(?:md|markdown)\s*\n([\s\S]*?)\n```(?=\n|$)/gi;

const codeFenceLinePattern = /^\s*```/gm;

const sanitizeSchema: SanitizeOptions = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-[\w-]+$/]],
    input: [...(defaultSchema.attributes?.input ?? []), ['type', 'checkbox'], ['checked'], ['disabled'], ['aria-checked']],
  },
};

function hasMarkdownTable(text: string) {
  const lines = text.split('\n');
  return lines.some((line, index) => {
    if (!line.includes('|')) return false;
    const next = lines[index + 1];
    return Boolean(next && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next));
  });
}

function unwrapMarkdownTableFences(text: string) {
  return text.replace(markdownFencePattern, (match, prefix: string, body: string) => (hasMarkdownTable(body) ? `${prefix}${body.trim()}` : match));
}

function closeUnclosedCodeFenceForPreview(text: string) {
  const fences = text.match(codeFenceLinePattern);
  if (!fences || fences.length % 2 === 0) {
    return text;
  }

  return `${text}\n\`\`\``;
}

function preprocessAgentMarkdown(text: string, streaming?: boolean) {
  const unwrapped = unwrapMarkdownTableFences(text);
  return streaming ? closeUnclosedCodeFenceForPreview(unwrapped) : unwrapped;
}

function codeText(children: ReactNode) {
  return Children.toArray(children).join('').replace(/\n$/, '');
}

function languageFromClassName(className: unknown) {
  if (typeof className !== 'string') {
    return undefined;
  }
  return /(?:^|\s)language-([\w-]+)/.exec(className)?.[1];
}

function getCodeChild(children: ReactNode) {
  const childArray = Children.toArray(children);
  if (childArray.length !== 1) {
    return undefined;
  }
  const onlyChild = childArray[0];
  if (!isValidElement<CodeElementProps>(onlyChild)) {
    return undefined;
  }
  return onlyChild;
}

function MarkdownPre({ children, node, ...props }: PreElementProps) {
  void node;

  const codeChild = getCodeChild(children);
  const code = codeChild ? codeText(codeChild.props.children) : codeText(children);
  const language = languageFromClassName(codeChild?.props.className);
  const [copied, setCopied] = useState(false);

  const copyCode = useCallback(async () => {
    if (!navigator.clipboard) {
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }

    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [code]);

  return (
    <div className="orrery-code-block">
      <div className="orrery-code-block__bar">
        <span className="orrery-code-block__lang">{language ?? 'text'}</span>
        <Button type="button" variant="ghost" size="icon-xs" className="h-6 w-6 text-term-dim hover:text-term-name" aria-label="Copy code" onClick={copyCode}>
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </Button>
      </div>
      <pre {...props}>{children}</pre>
    </div>
  );
}

function MarkdownCode({ children, className, node, ...props }: CodeElementProps) {
  void node;

  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

function MarkdownLink({ href, children, node, ...props }: LinkElementProps) {
  void node;

  const safeHref = href ?? '';
  const isExternal = /^https?:\/\//i.test(safeHref);
  const isHash = safeHref.startsWith('#');
  const isMailto = /^mailto:/i.test(safeHref);

  if (!isExternal && !isHash && !isMailto) {
    return <span className="orrery-markdown-file-ref">{children}</span>;
  }

  return (
    <a {...props} href={safeHref} target={isExternal ? '_blank' : undefined} rel={isExternal ? 'noreferrer' : undefined}>
      {children}
    </a>
  );
}

function MarkdownTable({ children, node, ...props }: TableElementProps) {
  void node;

  return (
    <div className="orrery-markdown-table-wrap">
      <table {...props}>{children}</table>
    </div>
  );
}

const markdownComponents: Components = {
  a: MarkdownLink,
  pre: MarkdownPre,
  code: MarkdownCode,
  table: MarkdownTable,
};

const markdownUrlTransform: UrlTransform = (url) => {
  if (/^file:/i.test(url)) {
    return '';
  }

  return defaultUrlTransform(url);
};

export const AgentMarkdown = memo(function AgentMarkdown({ text, streaming = false, className }: AgentMarkdownProps) {
  const normalized = useMemo(() => preprocessAgentMarkdown(text, streaming), [streaming, text]);

  return (
    <div className={cn('orrery-markdown text-term-name', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
        components={markdownComponents}
        disallowedElements={['img']}
        skipHtml
        urlTransform={markdownUrlTransform}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
});
