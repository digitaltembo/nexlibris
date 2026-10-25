import type { Plugin } from '../../devices/types';
import { ShelfIcon } from '../../components/icons';
import { Bookshelf } from './Bookshelf';
import { t } from '../../i18n';

/** The library as a bookshelf (a third view, beside grid and list). */
export const bookshelf: Plugin = {
  id: 'bookshelf',
  name: 'Bookshelf',
  connectionTypes: [],
  views: [{ id: 'bookshelf.shelf', label: t('views.bookshelf'), icon: <ShelfIcon />, component: Bookshelf }],
};
