import { hexColor } from '@nexlibris/common';
import type { EpubierReader } from 'epubier/all';
import { useEffect, useRef } from 'react';
import styled from 'styled-components';
import { inDesktopApp, watchFullScreen } from '../backends/desktopBridge';
import { readsInWindows } from '../library/readerWindow';
import { epubierFormat } from './epubierFormat';
import type { ViewerProps } from './Reader';

const Host = styled.div`
  height: 100%;

  > * {
    height: 100%;
  }
`;

/** pdf.js's own files, served beside the app (`pdfjsAssets` in `vite.config.ts`). */
const PDFJS_ASSETS = `${import.meta.env.BASE_URL}pdfjs/`;
/** epubier's worker for CBR and CB7 comics, with libarchive.wasm beside it, served beside the app (`epubierAssets`). */
const COMIC_ARCHIVE_WORKER = new URL(`${import.meta.env.BASE_URL}epubier/comicarchive.worker.js`, document.baseURI).href;

/**
 * ePubs, Kindle books, PDFs, comics and RTF are read with epubier, which brings its own toolbar: no back button in a
 * book's own window, which closes as windows do, and no fullscreen, and no sharing (a link to a page or passage here leads nowhere else).
 * In the desktop app the toolbar is the window's title bar, which on macOS keeps clear of the window's buttons, and
 * epubier's fullscreen is the window's: either one going full screen takes the other with it. Its locators are the library's (a CFI, or a PDF's page number), except a comic's: the library keeps the page's
 * index, where epubier counts from 1. An RTF can also be opened at a fraction of the way through its text, as its
 * text search finds a passage (and as nexlibris's own viewer kept its place, before epubier read RTF), which it goes to
 * once epubier has counted the pages, as its pages are a measure of the text too. It's given the file as a Blob, which comics are read from a page at a time, so a
 * large one isn't loaded whole.
 */
export default function EpubierViewer({ data, format, storageKey, position, onPosition, onClose, onColors }: ViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
  const onColorsRef = useRef(onColors);
  onColorsRef.current = onColors;

  useEffect(() => {
    const kind = epubierFormat(format);
    const shift = kind === 'cbz' || kind === 'comicarchive' ? 1 : 0;
    const fraction = kind === 'rtf' && position !== undefined && !position.startsWith('epubcfi(') ? Number(position) : undefined;
    const at =
      position !== undefined && shift
        ? String(Math.max(0, Math.floor(Number(position)) || 0) + shift)
        : fraction === undefined
          ? position
          : undefined;
    let reader: EpubierReader | undefined;
    let cancelled = false;
    const desktop = window.NexlibrisDesktop;
    const stopWatching = watchFullScreen((on) => reader?.setFullscreen(on), desktop);
    void Promise.all([
      import('epubier/all'),
      kind === 'pdf' ? import('pdfjs-dist/build/pdf.worker.min.mjs?url').then((m) => m.default) : undefined,
    ]).then(([{ default: epubier }, workerSrc]) => {
      const target = hostRef.current?.firstElementChild;
      if (cancelled || !(target instanceof HTMLElement)) return;
      reader = epubier(target, data, {
        ...(kind && { format: kind }),
        storageKey,
        replacements: 'base64',
        position: at,
        ...(workerSrc && { pdf: { workerSrc, assetsUrl: PDFJS_ASSETS } }),
        comicArchive: { workerUrl: COMIC_ARCHIVE_WORKER },
        onLocationChange: ({ location, progress }) =>
          onPositionRef.current?.(shift ? String(Number(location) - shift) : location, progress ?? undefined),
        onBackPressed: () => onCloseRef.current(),
        toolbar: { back: !readsInWindows(), fullscreen: false },
        share: false,
        titleBar: inDesktopApp(),
        ...(desktop?.setFullScreen && {
          browserFullscreen: false,
          onFullscreenChange: (on: boolean) => desktop.setFullScreen?.(on),
        }),
        // The theme picked in epubier's settings colours what's around it too (the system bars).
        onThemeChange: ({ background, dark }) => {
          const hex = hexColor(background);
          if (hex) onColorsRef.current?.({ background: hex, dark });
        },
        styles: { accent: '#0d3b66', background: '#fdf8e5', '--ep-toolbar-inset-left': 'var(--reader-title-bar-inset, 0px)' },
      });
      if (fraction !== undefined && fraction > 0 && fraction <= 1) {
        void reader.ready.then((session) => session?.pages.then(() => !cancelled && session.displayProgress(fraction)));
      }
    });
    return () => {
      cancelled = true;
      stopWatching();
      reader?.destroy();
      // epubier keeps the reading position in the hash; don't leave it behind.
      if (location.hash.startsWith('#loc=')) history.replaceState(null, '', location.pathname + location.search);
    };
  }, [data, format, storageKey, position]);

  // epubier replaces the inner element with its own root, so React only owns the host.
  return (
    <Host ref={hostRef}>
      <div />
    </Host>
  );
}
