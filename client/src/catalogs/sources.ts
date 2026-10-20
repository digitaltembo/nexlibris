import type { Device, Library, LibraryBackend } from '@nexlibris/common';
import { useEffect, useMemo, useState } from 'react';
import { catalogAuth, onCredentialsChange, type CatalogAuth } from './credentials';
import { canSearch } from './feedCache';
import { isFeed, type FeedType } from '../devices/types';
import { connectionType } from '../connections';

/** Connections to catalogs on servers that are browsed (`devices/types.ts`'s `FeedType`), not synced. */
export function sourceOf(device: Device): FeedType | undefined {
  const type = connectionType(device.type);
  return type && isFeed(type) ? type : undefined;
}

export const isSourceConnection = (device: Device) => sourceOf(device) !== undefined;

/** The library's browsable catalogs, by name, with where each starts. */
export function librarySources(devices: Library['devices']): { device: Device; url: string }[] {
  return Object.values(devices ?? {})
    .flatMap((device) => {
      const url = sourceOf(device)?.url(device);
      return url ? [{ device, url }] : [];
    })
    .sort((a, b) => a.device.name.localeCompare(b.device.name));
}

/**
 * The catalogs that offer search, by what's cached of them (a catalog is known to once its start
 * has been read: when it was added or browsed). Rechecked when `when` changes, e.g. as the search opens.
 */
export function useSearchableSources(backend: LibraryBackend, devices: Library['devices'], when: unknown): { id: string; name: string }[] {
  const [searchable, setSearchable] = useState<{ id: string; name: string }[]>([]);
  const sources = useMemo(() => librarySources(devices), [devices]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      sources.map(async ({ device, url }) =>
        (await canSearch(backend, url, sourceOf(device)?.searchTemplate?.(device))) ? [{ id: device.id, name: device.name }] : [],
      ),
    ).then(
      (found) => !cancelled && setSearchable(found.flat()),
    );
    return () => {
      cancelled = true;
    };
  }, [backend, sources, when]);
  return searchable;
}

/** A connection's sign-in (`credentials.ts`), once it's been read; `ready` till then false. */
export function useCatalogAuth(backend: LibraryBackend, deviceId: string, root: string): { ready: boolean; auth?: CatalogAuth } {
  const [state, setState] = useState<{ key: string; auth?: CatalogAuth }>();
  const [changes, setChanges] = useState(0);
  useEffect(() => onCredentialsChange(() => setChanges((n) => n + 1)), []);
  const key = `${deviceId}\n${root}\n${changes}`;
  useEffect(() => {
    let cancelled = false;
    void catalogAuth(backend, deviceId, root).then(
      (auth) => !cancelled && setState({ key, ...(auth && { auth }) }),
      () => !cancelled && setState({ key }),
    );
    return () => {
      cancelled = true;
    };
  }, [backend, deviceId, root, key]);
  return state?.key === key ? { ready: true, ...(state.auth && { auth: state.auth }) } : { ready: false };
}
