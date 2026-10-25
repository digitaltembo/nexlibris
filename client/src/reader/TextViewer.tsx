import { useEffect, useRef, useState } from 'react';
import styled, { css } from 'styled-components';
import { decodeText } from '@nexlibris/tools/formats/text';
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
import type { ViewerProps } from './Reader';
import { useScrollFraction } from './scroll';
import { t } from '../i18n';

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

  if (text === undefined) return <Status>{t('common.opening')}</Status>;
  return <TextDoc ref={docRef}>{text}</TextDoc>;
}
