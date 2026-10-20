import type { Plugin } from '../devices/types';
import type { LibraryViewType } from '../views/types';
import { bookshelf } from './bookshelf';
import { crosspoint } from './crosspoint';
import { graph } from './graph';

/** The plugins built into nexlibris. Connection types built in rather than plugged in are in `connections/`. */
export const PLUGINS: Plugin[] = [crosspoint, bookshelf, graph];

export const VIEW_TYPES: LibraryViewType[] = PLUGINS.flatMap((p) => p.views ?? []);

export const viewType = (id: string) => VIEW_TYPES.find((v) => v.id === id);
