import { useEffect, useRef, useState } from 'react';
import styled, { css } from 'styled-components';
import { decodeText, loadRtfjs } from '@nexlibris/tools/formats/text';
import { Status } from '../styles/ui';

const docStyles = css`
  max-width: 70ch;
  margin: 0 auto;
  padding: 32px 16px 64px;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 1.05rem;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

const TextDoc = styled.pre`
  ${docStyles}
`;

/** rtf.js sets its own colors, so it gets a light page whatever the theme. */
const RtfDoc = styled.div`
  ${docStyles}
  min-height: 100%;
  white-space: normal;
  background: #fffdf5;
  color: #0a2540;
`;
import type { ViewerProps } from './Reader';
import { useScrollFraction } from './scroll';

export function PlainTextViewer({ data, position, onPosition }: ViewerProps) {
  const [text, setText] = useState<string>();
  const docRef = useRef<HTMLPreElement>(null);
  useScrollFraction(docRef, text !== undefined, position, onPosition);
  useEffect(() => {
    let cancelled = false;
    void data.arrayBuffer().then((buffer) => {
      if (!cancelled) setText(decodeText(buffer));
    });
    return () => {
      cancelled = true;
    };
  }, [data]);

  if (text === undefined) return <Status>Opening…</Status>;
  return <TextDoc ref={docRef}>{text}</TextDoc>;
}

export function RtfViewer({ data, position, onPosition }: ViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const [rendered, setRendered] = useState(false);
  useScrollFraction(containerRef, rendered, position, onPosition);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const RTFJS = await loadRtfjs();
        const elements = await new RTFJS.Document(await data.arrayBuffer(), {}).render();
        if (cancelled) return;
        containerRef.current?.replaceChildren(...elements);
        setRendered(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  if (error) return <Status $error>{error}</Status>;
  return <RtfDoc ref={containerRef} />;
}
