import { useEffect, useRef, useState } from 'react';
import styled, { css } from 'styled-components';
import { decodeText, loadRtfjs } from '../formats/text';
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
  background: #ffffff;
  color: #22201c;
`;
import type { ViewerProps } from './Reader';

export function PlainTextViewer({ data }: ViewerProps) {
  const [text, setText] = useState<string>();
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
  return <TextDoc>{text}</TextDoc>;
}

export function RtfViewer({ data }: ViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const RTFJS = await loadRtfjs();
        const elements = await new RTFJS.Document(await data.arrayBuffer(), {}).render();
        if (!cancelled) containerRef.current?.replaceChildren(...elements);
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
