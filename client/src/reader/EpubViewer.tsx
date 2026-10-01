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
export default function EpubViewer({ data, storageKey, onClose }: ViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    let reader: EpubierReader | undefined;
    let cancelled = false;
    void Promise.all([import('epubier'), data.arrayBuffer()]).then(([{ default: epubier }, buffer]) => {
      const target = hostRef.current?.firstElementChild;
      if (cancelled || !(target instanceof HTMLElement)) return;
      reader = epubier(target, buffer, {
        storageKey,
        onBackPressed: () => onCloseRef.current(),
        styles: { accent: '#8a4b2a', background: '#faf8f5' },
      });
    });
    return () => {
      cancelled = true;
      reader?.destroy();
      // epubier keeps the reading position in the hash; don't leave it behind.
      if (location.hash.startsWith('#loc=')) history.replaceState(null, '', location.pathname + location.search);
    };
  }, [data, storageKey]);

  // epubier replaces the inner element with its own root, so React only owns the host.
  return (
    <Host ref={hostRef}>
      <div />
    </Host>
  );
}
