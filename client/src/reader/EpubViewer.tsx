import { hexColor } from '@nexlibris/common';
import type { EpubierReader } from 'epubier';
import { useEffect, useRef } from 'react';
import styled from 'styled-components';
import type { ViewerProps } from './Reader';

const Host = styled.div`
  height: 100%;

  > * {
    height: 100%;
  }
`;

/** EPUBs are read with epubier, which brings its own toolbar, including the back button. */
export default function EpubViewer({ data, storageKey, position, onPosition, onClose, onColors }: ViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
  const onColorsRef = useRef(onColors);
  onColorsRef.current = onColors;

  useEffect(() => {
    let reader: EpubierReader | undefined;
    let cancelled = false;
    void Promise.all([import('epubier'), data.arrayBuffer()]).then(([{ default: epubier }, buffer]) => {
      const target = hostRef.current?.firstElementChild;
      if (cancelled || !(target instanceof HTMLElement)) return;
      reader = epubier(target, buffer, {
        storageKey,
        replacements: 'base64',
        position,
        onLocationChange: ({ cfi, progress }) => onPositionRef.current?.(cfi, progress ?? undefined),
        onBackPressed: () => onCloseRef.current(),
        // The theme picked in epubier's settings colours what's around it too (the title bar strip, the system bars).
        onThemeChange: ({ background, dark }) => {
          const hex = hexColor(background);
          if (hex) onColorsRef.current?.({ background: hex, dark });
        },
        styles: { accent: '#0d3b66', background: '#fdf8e5' },
      });
    });
    return () => {
      cancelled = true;
      reader?.destroy();
      // epubier keeps the reading position in the hash; don't leave it behind.
      if (location.hash.startsWith('#loc=')) history.replaceState(null, '', location.pathname + location.search);
    };
  }, [data, storageKey, position]);

  // epubier replaces the inner element with its own root, so React only owns the host.
  return (
    <Host ref={hostRef}>
      <div />
    </Host>
  );
}
