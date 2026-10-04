import type { Cover, FileHash } from '@nexlibris/common';
import { useEffect, useRef, useState } from 'react';
import { useLibrary } from './LibraryContext';
import { coverThumbnail } from './thumbnails';

/**
 * An object URL for what `load` gives for `hash`: undefined while loading (or with no hash), null
 * if there's nothing. Revoked when the hash changes or on unmount.
 */
function useBlobUrl(hash: FileHash | undefined, type: string | undefined, load: (hash: FileHash) => Promise<Blob | undefined>) {
  const { backend } = useLibrary();
  const [url, setUrl] = useState<string | null>();
  const loader = useRef(load);
  loader.current = load;

  useEffect(() => {
    if (!hash) return;
    let objectUrl: string | undefined;
    let cancelled = false;
    loader.current(hash).then(
      (blob) => {
        if (cancelled) return;
        if (!blob) return setUrl(null);
        // A slice shares the blob's bytes rather than copying them.
        objectUrl = URL.createObjectURL(type ? blob.slice(0, blob.size, type) : blob);
        setUrl(objectUrl);
      },
      // A file the sync hub couldn't provide: shown as missing, like one that isn't stored.
      () => !cancelled && setUrl(null),
    );
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(undefined);
    };
  }, [backend, hash, type]);

  return url;
}

/** An object URL for a stored file: undefined while it loads, null if it isn't stored. */
export function useFileUrl(hash: FileHash | undefined, type?: string): string | null | undefined {
  const { backend } = useLibrary();
  return useBlobUrl(hash, type, (h) => backend.getFile(h));
}

/** An object URL for a cover's thumbnail (see `thumbnails.ts`): undefined while it loads, null if there's no cover here. */
export function useThumbnailUrl(cover: Cover | undefined): string | null | undefined {
  const { backend } = useLibrary();
  return useBlobUrl(cover?.hash, undefined, () => coverThumbnail(backend, cover!));
}
