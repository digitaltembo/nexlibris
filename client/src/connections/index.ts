import type { Device, Library } from '@nexlibris/common';
import { isFeed, type ConnectionType } from '../devices/types';
import { PLUGINS } from '../plugins';
import { folderType } from './folder';
import { instanceType } from './instance';
import { opdsExport, opdsServer } from './opds';

/** The connection types built into nexlibris, whatever plugins there are. */
export const BUILT_IN_CONNECTIONS: ConnectionType[] = [instanceType, folderType, opdsServer, opdsExport];

/** Every connection type: the built-ins, then the plugins'. */
export const CONNECTION_TYPES: ConnectionType[] = [...BUILT_IN_CONNECTIONS, ...PLUGINS.flatMap((p) => p.connectionTypes)];

export const connectionType = (id: string) => CONNECTION_TYPES.find((t) => t.id === id);

/**
 * The connections the Library lists to browse beside its catalogs on servers (`['connection', id]` in
 * `browse.ts`): those that read and can be used here, other than this instance's own. The Library
 * lists only the active ones (`active.ts`).
 */
export function readableConnections(library: Library): { id: string; name: string; device: Device; type: ConnectionType }[] {
  return Object.values(library.devices ?? {})
    .flatMap((device) => {
      const type = connectionType(device.type);
      return type?.read && !isFeed(type) && device.id !== library.origin ? [{ id: device.id, name: device.name, device, type }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
