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
export default function EpubViewer({ data, storageKey, position, onPosition, onClose }: ViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;

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
