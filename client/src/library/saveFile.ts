import { createMessageClient, saveApiMeta, savePartsOverRpc, type FileParts } from '@nexlibris/common';
import { nativeTransport } from '../backends/native';

export interface SaveOptions {
  mimeType?: string;
  /** Called as bytes are written. */
  onProgress?(bytes: number): void;
}

/** Starts a browser download of `blob`. */
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Give the browser a moment to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

interface SavePickerWindow {
  showSaveFilePicker?(options: { suggestedName: string }): Promise<{
    createWritable(): Promise<{ write(data: Blob | Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
  }>;
}

/**
 * Saves a file out of the app, a piece at a time so a large one (a multi-GB backup) is never
 * all in memory: in the Android or desktop app through the system "Save as" dialog, in a browser
 * with a save picker (Chrome) straight to the chosen file, otherwise as a download of the pieces
 * joined into one Blob (Blobs made from stored files stay on disk). False if the user cancelled
 * (a browser download can't be, as far as the page can tell).
 *
 * `parts` is called only once a destination is chosen, if there's a choice to make first: a
 * browser only shows its save picker straight after a click, so call this before awaiting
 * anything else.
 */
export async function saveParts(name: string, parts: () => FileParts, options: SaveOptions = {}): Promise<boolean> {
  const { mimeType = 'application/octet-stream', onProgress } = options;
  let written = 0;
  const progress = (bytes: number) => onProgress?.((written += bytes));
  const size = (part: Uint8Array | Blob) => (part instanceof Blob ? part.size : part.length);

  const transport = nativeTransport();
  if (transport) {
    return savePartsOverRpc(createMessageClient(saveApiMeta, transport).save, parts(), name, { mimeType, onProgress });
  }

  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (picker) {
    let handle;
    try {
      handle = await picker.call(window, { suggestedName: name });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return false;
      // E.g. SecurityError when it wasn't straight after a click: fall back to a download.
    }
    if (handle) {
      const writable = await handle.createWritable();
      try {
        for await (const part of parts()) {
          await writable.write(part);
          progress(size(part));
        }
        await writable.close();
      } catch (e) {
        await writable.abort().catch(() => undefined);
        throw e;
      }
      return true;
    }
  }

  const pieces: (Uint8Array | Blob)[] = [];
  for await (const part of parts()) {
    pieces.push(part);
    progress(size(part));
  }
  download(new Blob(pieces as BlobPart[], { type: mimeType }), name);
  return true;
}

/** Saves `blob` out of the app (see `saveParts`). */
export const saveFile = (blob: Blob, name: string): Promise<boolean> =>
  saveParts(name, () => [blob], { mimeType: blob.type || undefined });
