import type { ConnectionType, Plugin } from '../devices/types';
import type { LibraryViewType } from '../views/types';
import { bookshelf } from './bookshelf';
import { crosspoint } from './crosspoint';
import { graph } from './graph';
import { nexlibris } from './nexlibris';
import { opds } from './opds';

/** The plugins built into nexlibris. */
export const PLUGINS: Plugin[] = [crosspoint, opds, nexlibris, bookshelf, graph];

export const CONNECTION_TYPES: ConnectionType[] = PLUGINS.flatMap((p) => p.connectionTypes);

export const connectionType = (id: string) => CONNECTION_TYPES.find((t) => t.id === id);

export const VIEW_TYPES: LibraryViewType[] = PLUGINS.flatMap((p) => p.views ?? []);

export const viewType = (id: string) => VIEW_TYPES.find((v) => v.id === id);
