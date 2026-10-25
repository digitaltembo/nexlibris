import type { Category, Conflict, Creator, Library, Target } from '@nexlibris/common';
import { t } from '../i18n';

/** How a sync preview shows a conflict: what it's about, and each side's value. */
export interface ConflictView {
  /** E.g. "Dune — title", "X4 — setting “address”". */
  what: string;
  ours: string;
  theirs: string;
}

const quoted = (text: string) => t('conflicts.quoted', { text });

function itemName(libraries: { ours: Library; theirs: Library }, id: string): string {
  return libraries.ours.items[id]?.title ?? libraries.theirs.items[id]?.title ?? t('conflicts.aBook');
}

function deviceName(libraries: { ours: Library; theirs: Library }, id: string): string {
  return libraries.ours.devices?.[id]?.name ?? libraries.theirs.devices?.[id]?.name ?? t('conflicts.aDevice');
}

/** What a target is about, in words. */
export function describeTarget(target: Target, libraries: { ours: Library; theirs: Library }): string {
  if (target[0] === 'item') {
    const name = itemName(libraries, target[1]);
    if (target.length === 2) return name;
    switch (target[2]) {
      case 'metadata':
        return t('conflicts.part', { name, part: target[3] });
      case 'tag':
        return t('conflicts.tag', { name, tag: quoted(target[3]) });
      case 'file':
        return t('conflicts.file', { name });
      case 'creators':
        return t('conflicts.authors', { name });
      default:
        return t('conflicts.part', { name, part: target[2] });
    }
  }
  if (target[0] === 'device') {
    const name = deviceName(libraries, target[1]);
    if (target.length === 2) return t('conflicts.device', { name });
    switch (target[2]) {
      case 'setting':
        return t('conflicts.setting', { name, setting: quoted(target[3]) });
      case 'item':
      case 'excluded':
        return t('conflicts.part', { name, part: itemName(libraries, target[3]) });
      case 'placed':
        return t('conflicts.part', { name, part: target[3] });
      default:
        return t('conflicts.part', { name, part: target[2] });
    }
  }
  if (target[0] === 'category') {
    const name = libraries.ours.categories?.[target[1]]?.name ?? libraries.theirs.categories?.[target[1]]?.name ?? t('conflicts.aCategory');
    return t('conflicts.category', { name: quoted(name) });
  }
  return t('conflicts.part', { name: itemName(libraries, target[2]), part: target[0] });
}

/** A side's value of a target, in words. */
export function describeValue(target: Target, value: unknown): string {
  if (target.length === 2) return value ? t('conflicts.kept') : t('conflicts.removed');
  if (target[0] === 'device' && target[2] === 'item') return value ? t('conflicts.onDevice') : t('conflicts.notOnDevice');
  if (target[0] === 'device' && target[2] === 'excluded') return value ? t('conflicts.keptOff') : t('conflicts.notKeptOff');
  if (target[0] === 'category') {
    if (!value) return t('conflicts.removed');
    const { name, entries } = value as Category;
    return t('conflicts.entries', {
      name: quoted(name),
      entries: entries.map((e) => e.label || e.query).join(t('common.listJoin')) || t('conflicts.noEntries'),
    });
  }
  if (value === undefined || value === null || value === '') return t('conflicts.none');
  if (target[0] === 'item' && target[2] === 'tag') return t('conflicts.tagged');
  if (target[0] === 'item' && target[2] === 'creators') return (value as Creator[]).map((c) => c.name).join(t('common.listJoin')) || t('conflicts.none');
  if (target[0] === 'item' && target[2] === 'file') {
    const name = (value as { name?: string; format?: string }).name;
    return name ?? (value as { format?: string }).format ?? t('conflicts.attached');
  }
  if (target[0] === 'rating') return t('conflicts.rating', { value: String(value) });
  if (typeof value === 'string') return quoted(value.length > 80 ? `${value.slice(0, 79)}…` : value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const json = JSON.stringify(value);
  return json.length > 80 ? `${json.slice(0, 79)}…` : json;
}

export function describeConflict(conflict: Conflict, libraries: { ours: Library; theirs: Library }): ConflictView {
  return {
    what: describeTarget(conflict.target, libraries),
    ours: describeValue(conflict.target, conflict.ours),
    theirs: describeValue(conflict.target, conflict.theirs),
  };
}
