import { useEffect, useState } from 'react';

/** Reads an image that needs a sign-in; undefined when it needs none, so is shown by its address. */
export type ImageFetcher = (url: string) => Promise<Blob | undefined>;

/**
 * An image of a catalog's, ready for `<img src>`: its address, or, where it needs the catalog's
 * sign-in (`fetchImage`), the image read with it as an object URL (released when it's let go of).
 * Undefined while loading or not `wanted`; null if it couldn't be read.
 */
export function useCatalogImage(url: string | undefined, fetchImage: ImageFetcher | undefined, wanted = true): string | null | undefined {
  const [loaded, setLoaded] = useState<{ url: string; src: string | null }>();
  useEffect(() => {
    if (!url || !wanted || !fetchImage || url.startsWith('data:')) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    fetchImage(url).then(
      (blob) => {
        if (cancelled) return;
        if (blob) objectUrl = URL.createObjectURL(blob);
        setLoaded({ url, src: objectUrl ?? url });
      },
      () => !cancelled && setLoaded({ url, src: null }),
    );
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, fetchImage, wanted]);
  if (!url || !wanted) return undefined;
  if (!fetchImage || url.startsWith('data:')) return url;
  return loaded?.url === url ? loaded.src : undefined;
}
