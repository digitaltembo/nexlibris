import type { Plugin } from '../../devices/types';
import { ShelfIcon } from '../../components/icons';
import { Bookshelf } from './Bookshelf';

/** The library as a bookshelf (a third view, beside grid and list). */
export const bookshelf: Plugin = {
  id: 'bookshelf',
  name: 'Bookshelf',
  connectionTypes: [],
  views: [{ id: 'bookshelf.shelf', label: 'Bookshelf', icon: <ShelfIcon />, component: Bookshelf }],
};
