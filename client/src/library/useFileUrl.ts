import type { FileHash } from '@nexlibris/common';
import { useEffect, useState } from 'react';
import { useLibrary } from './LibraryContext';

/** An object URL for a stored file, revoked when the hash changes or on unmount. */
export function useFileUrl(hash: FileHash | undefined, type?: string): string | undefined {
  const { backend } = useLibrary();
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    if (!hash) return;
    let objectUrl: string | undefined;
    let cancelled = false;
    void backend.getFile(hash).then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(type ? new Blob([blob], { type }) : blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(undefined);
    };
  }, [backend, hash, type]);

  return url;
}
