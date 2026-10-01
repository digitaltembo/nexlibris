import { createElement, type ReactNode } from 'react';
import styled from 'styled-components';

/** Text written by a person (or a publisher), keeping its line breaks. */
export const Prose = styled.p`
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

const RichProse = styled.div`
  overflow-wrap: anywhere;

  > :first-child {
    margin-top: 0;
  }

  > :last-child {
    margin-bottom: 0;
  }

  p,
  ul,
  ol,
  blockquote {
    margin: 0 0 0.6em;
  }

  ul,
  ol {
    padding-left: 1.4em;
  }

  h4 {
    margin: 0 0 0.3em;
    font-size: 1em;
  }

  a {
    color: var(--accent);
  }
`;

/** Formatting kept from description HTML; anything else is unwrapped to its text, or dropped. */
const ALLOWED = new Set([
  'p', 'div', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'small', 'code', 'span',
  'ul', 'ol', 'li', 'blockquote', 'h4', 'a',
]);
/** Elements whose content isn't readable text. */
const DROPPED = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'head', 'title', 'noscript']);
/** Headings are all one small size so a description can't outshout the panel. */
const RENAMED: Record<string, string> = { h1: 'h4', h2: 'h4', h3: 'h4', h5: 'h4', h6: 'h4' };

export const looksLikeHtml = (text: string) => /<\/?[a-z][\s\S]*?>/i.test(text) || /&(#\d+|#x[\da-f]+|[a-z]+);/i.test(text);

function safeHref(href: string | null): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function convert(node: Node, key: number): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const name = el.localName;
  if (DROPPED.has(name)) return null;
  const children = Array.from(el.childNodes, convert);
  const tag = RENAMED[name] ?? name;
  if (!ALLOWED.has(tag)) return children;
  if (tag === 'br' || tag === 'hr') return createElement(tag, { key });
  if (tag === 'a') {
    const href = safeHref(el.getAttribute('href'));
    return href ? createElement('a', { key, href, target: '_blank', rel: 'noopener noreferrer nofollow' }, ...children) : children;
  }
  // No attributes are carried over: no styles, classes, ids or handlers.
  return createElement(tag, { key }, ...children);
}

/** Renders untrusted HTML (like EPUB descriptions) as React elements, keeping only basic formatting. */
export function htmlToReact(html: string): ReactNode {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.body.childNodes, convert);
}

/** Description text that may be HTML or plain text. */
export function RichText({ text }: { text: string }) {
  return looksLikeHtml(text) ? <RichProse>{htmlToReact(text)}</RichProse> : <Prose>{text}</Prose>;
}
