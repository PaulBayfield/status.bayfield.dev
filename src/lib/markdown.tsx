// A small Markdown renderer for status page descriptions. It builds React elements (never HTML
// strings), so whatever someone types can't inject markup or scripts; links are limited to
// http(s) and mailto.
//
// Blocks: paragraphs (a single line break stays a line break), # headings, - / * / 1. lists,
// > quotes. Inline: **bold**, *italic* / _italic_, ~~strike~~, `code`, [text](url), bare URLs.

import { Fragment, type ReactNode } from "react";

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

// Order matters: code first (its content stays literal), then links, then emphasis.
const INLINE =
  /(`[^`\n]+`)|\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|~~([^~\n]+?)~~|\*([^*\n]+?)\*|(?<![\w])_([^_\n]+?)_(?![\w])/g;

function link(href: string, children: ReactNode, key: number): ReactNode {
  if (!SAFE_URL.test(href)) return <Fragment key={key}>{children}</Fragment>;
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [whole, code, label, href, bare, bold1, bold2, strike, em1, em2] = m;
    if (code) out.push(<code key={key++}>{code.slice(1, -1)}</code>);
    else if (label) out.push(link(href, inline(label), key++));
    else if (bare) out.push(link(bare, bare, key++));
    else if (bold1 ?? bold2) out.push(<strong key={key++}>{inline(bold1 ?? bold2)}</strong>);
    else if (strike) out.push(<s key={key++}>{inline(strike)}</s>);
    else if (em1 ?? em2) out.push(<em key={key++}>{inline(em1 ?? em2)}</em>);
    else out.push(whole);
    last = m.index + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Lines joined with line breaks, each with its inline formatting. */
function lines(list: string[]): ReactNode[] {
  return list.flatMap((l, i) => (i ? [<br key={`br${i}`} />, ...inline(l)] : inline(l)));
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*$/;
const QUOTE = /^\s*>\s?(.*)$/;

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  const src = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < src.length) {
    const line = src[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const key = blocks.length;
    const h = HEADING.exec(line);
    if (h) {
      // Headings sit under the page title, so they start a level below it.
      const level = Math.min(6, h[1].length + 2);
      const Tag = `h${level}` as "h3";
      blocks.push(<Tag key={key}>{inline(h[2])}</Tag>);
      i++;
      continue;
    }
    for (const [pattern, Tag] of [
      [BULLET, "ul"],
      [NUMBER, "ol"],
    ] as const) {
      if (!pattern.test(line)) continue;
      const items: string[] = [];
      while (i < src.length && pattern.test(src[i])) items.push(pattern.exec(src[i++])![1]);
      blocks.push(
        <Tag key={key}>
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </Tag>,
      );
      break;
    }
    if (blocks.length > key) continue;
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < src.length && QUOTE.test(src[i])) quoted.push(QUOTE.exec(src[i++])![1]);
      blocks.push(<blockquote key={key}>{lines(quoted)}</blockquote>);
      continue;
    }
    // A paragraph runs until a blank line or the start of another block.
    const para: string[] = [];
    while (i < src.length && src[i].trim() && !HEADING.test(src[i]) && !BULLET.test(src[i]) && !NUMBER.test(src[i]) && !QUOTE.test(src[i])) para.push(src[i++]);
    blocks.push(<p key={key}>{lines(para)}</p>);
  }
  return <div className={`markdown${className ? ` ${className}` : ""}`}>{blocks}</div>;
}
