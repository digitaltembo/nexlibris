import type { ReactNode } from 'react';
import { GridIcon, ListIcon } from '../components/icons';
import { VIEW_TYPES } from '../plugins';
import { t } from '../i18n';

/** The chosen view: `grid`, `list`, or a plugin's view (`LibraryViewType.id`). */
export type View = string;

export interface ViewChoice {
  id: View;
  label: string;
  icon: ReactNode;
}

/** Every view on offer, the built-in ones first. */
export const VIEWS: ViewChoice[] = [
  { id: 'grid', label: t('views.grid'), icon: <GridIcon /> },
  { id: 'list', label: t('views.list'), icon: <ListIcon /> },
  ...VIEW_TYPES.map(({ id, label, icon }) => ({ id, label, icon })),
];

/** A stored view that's still on offer, else the grid (a plugin's view may have gone). */
export const knownView = (view: string): View => (VIEWS.some((v) => v.id === view) ? view : 'grid');
