import { LOCAL_USER, userData, type FileHash, type FileRef, type ItemId, type Library, type LibraryBackend, type Operation } from '@nexlibris/common';
import { inAndroidApp } from '../backends/androidBridge';

/**
 * Books are read in windows of their own in the browser and the desktop app (Android's WebView has
 * only the one, so it reads over the library). A reader window is the app's own page with the book
 * in its address, `?read=<item>&file=<hash>[&at=<locator>]`, which `main.tsx` shows as the reader
 * alone (`components/ReaderWindow.tsx`). It doesn't open the library: it asks the library's window
 * for the book (its title, file and contents, and where the reader left off) over a
 * BroadcastChannel, and sends that window where the reader moves, which it saves.
 */

export interface ReaderAddress {
  itemId: ItemId;
  hash: FileHash;
  /** Where to open it, e.g. a passage found by full-text search. */
  at?: string;
}

/** Whether books open in windows of their own here. */
export const readsInWindows = () => !inAndroidApp();

/** The reader window's address for a book, on this page's origin and path. */
export function readerUrl({ itemId, hash, at }: ReaderAddress, base: string = location.href): string {
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  url.searchParams.set('read', itemId);
  url.searchParams.set('file', hash);
  if (at) url.searchParams.set('at', at);
  return url.href;
}

/** The book a reader window's address names, or undefined for the library's own page. */
export function readerAddress(search: string = location.search): ReaderAddress | undefined {
  const params = new URLSearchParams(search);
  const itemId = params.get('read');
  const hash = params.get('file');
  if (!itemId || !hash) return undefined;
  const at = params.get('at');
  return { itemId, hash, ...(at && { at }) };
}

/**
 * Opens a book in a window of its own (the same book's window again, if it's open), returning
 * false if the browser wouldn't (a popup blocker, say), for the caller to read it in the page.
 */
export function openReaderWindow(address: ReaderAddress): boolean {
  const width = Math.min(960, screen.availWidth);
  const height = Math.min(1100, screen.availHeight);
  const opened = window.open(readerUrl(address), `nexlibris-read-${address.itemId}`, `popup,width=${width},height=${height}`);
  opened?.focus();
  return !!opened;
}

const CHANNEL = 'nexlibris:reader';

/** What a reader window gets: the book, and the library window that answered, to send positions to. */
export interface ReaderBook {
  title: string;
  file: FileRef;
  data: Blob;
  /** Where the reader left off in this file. */
  position?: string;
  library: string;
}

type Message =
  | { type: 'open'; reader: string; itemId: ItemId; hash: FileHash }
  | { type: 'book'; to: string; library: string; title: string; file: FileRef; data: Blob; position?: string }
  | { type: 'missing'; to: string; message: string }
  | { type: 'position'; to: string; itemId: ItemId; hash: FileHash; locator: string; progress?: number };

const newId = () => crypto.randomUUID();

/**
 * The library window's side: answers reader windows asking for a book, and saves the positions
 * they send it. `current` gives the library as it is now. Returns the way to stop.
 */
export function serveReaderWindows(
  backend: LibraryBackend,
  current: () => Library,
  apply: (ops: Operation[]) => Promise<unknown>,
): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(CHANNEL);
  const library = newId();
  const send = (message: Message) => channel.postMessage(message);
  channel.addEventListener('message', (event: MessageEvent<Message>) => {
    const message = event.data;
    if (message.type === 'open') {
      void (async () => {
        const item = current().items[message.itemId];
        const file = item?.files.find((f) => f.hash === message.hash);
        if (!item || !file) return send({ type: 'missing', to: message.reader, message: 'This book, or this file of it, is no longer in the library.' });
        try {
          const data = await backend.getFile(file.hash);
          if (!data) return send({ type: 'missing', to: message.reader, message: 'This file is missing from storage.' });
          const saved = userData(current()).positions?.[item.id];
          const position = saved?.hash === file.hash ? saved.locator : undefined;
          send({ type: 'book', to: message.reader, library, title: item.title, file, data, ...(position !== undefined && { position }) });
        } catch (e) {
          send({ type: 'missing', to: message.reader, message: e instanceof Error ? e.message : String(e) });
        }
      })();
    } else if (message.type === 'position' && message.to === library) {
      const { itemId, hash, locator, progress } = message;
      const position = { hash, locator, ...(progress !== undefined && { progress }) };
      // Fails if the item was deleted meanwhile, which leaves nothing to remember.
      apply([{ type: 'setPosition', userId: LOCAL_USER, itemId, position }]).catch(() => undefined);
    }
  });
  return () => channel.close();
}

/** How long a reader window waits for the library's window to answer. */
const ANSWER_MS = 10_000;

/**
 * The reader window's side: asks the library's window for the book (the first to answer, if the
 * library is open in more than one), and gives the way to send it positions.
 */
export function requestBook({ itemId, hash }: ReaderAddress): {
  book: Promise<ReaderBook>;
  sendPosition(book: ReaderBook, locator: string, progress?: number): void;
  close(): void;
} {
  const channel = new BroadcastChannel(CHANNEL);
  const reader = newId();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const book = new Promise<ReaderBook>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('The library didn’t answer. Open nexlibris, then open the book from there.')), ANSWER_MS);
    channel.addEventListener('message', (event: MessageEvent<Message>) => {
      const message = event.data;
      if (message.type !== 'book' && message.type !== 'missing') return;
      if (message.to !== reader) return;
      clearTimeout(timer);
      if (message.type === 'missing') return reject(new Error(message.message));
      const { title, file, data, position, library } = message;
      resolve({ title, file, data, library, ...(position !== undefined && { position }) });
    });
  });
  channel.postMessage({ type: 'open', reader, itemId, hash } satisfies Message);
  return {
    book,
    sendPosition(to, locator, progress) {
      if (closed) return;
      channel.postMessage({ type: 'position', to: to.library, itemId, hash, locator, ...(progress !== undefined && { progress }) } satisfies Message);
    },
    close() {
      // The window's last position is sent as it's hidden (`usePositionReports`), before this.
      closed = true;
      clearTimeout(timer);
      channel.close();
    },
  };
}
