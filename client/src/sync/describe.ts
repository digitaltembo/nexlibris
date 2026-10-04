import type { Category, Conflict, Creator, Library, Target } from '@nexlibris/common';

/** How a sync preview shows a conflict: what it's about, and each side's value. */
export interface ConflictView {
  /** E.g. "Dune — title", "X4 — setting “address”". */
  what: string;
  ours: string;
  theirs: string;
}

const quoted = (text: string) => `“${text}”`;

function itemName(libraries: { ours: Library; theirs: Library }, id: string): string {
  return libraries.ours.items[id]?.title ?? libraries.theirs.items[id]?.title ?? 'A book';
}

function deviceName(libraries: { ours: Library; theirs: Library }, id: string): string {
  return libraries.ours.devices?.[id]?.name ?? libraries.theirs.devices?.[id]?.name ?? 'A device';
}

/** What a target is about, in words. */
export function describeTarget(target: Target, libraries: { ours: Library; theirs: Library }): string {
  if (target[0] === 'item') {
    const name = itemName(libraries, target[1]);
    if (target.length === 2) return name;
    switch (target[2]) {
      case 'metadata':
        return `${name} — ${target[3]}`;
      case 'tag':
        return `${name} — tag ${quoted(target[3])}`;
      case 'file':
        return `${name} — a file`;
      case 'creators':
        return `${name} — authors`;
      default:
        return `${name} — ${target[2]}`;
    }
  }
  if (target[0] === 'device') {
    const name = deviceName(libraries, target[1]);
    if (target.length === 2) return `Device ${name}`;
    switch (target[2]) {
      case 'setting':
        return `${name} — setting ${quoted(target[3])}`;
      case 'item':
        return `${name} — ${itemName(libraries, target[3])}`;
      case 'placed':
        return `${name} — ${target[3]}`;
      default:
        return `${name} — ${target[2]}`;
    }
  }
  if (target[0] === 'category') {
    const name = libraries.ours.categories?.[target[1]]?.name ?? libraries.theirs.categories?.[target[1]]?.name ?? 'A category';
    return `Category ${quoted(name)}`;
  }
  return `${itemName(libraries, target[2])} — ${target[0]}`;
}

/** A side's value of a target, in words. */
export function describeValue(target: Target, value: unknown): string {
  if (target.length === 2) return value ? 'kept' : 'removed';
  if (target[0] === 'device' && target[2] === 'item') return value ? 'on the device' : 'not on the device';
  if (target[0] === 'category') {
    if (!value) return 'removed';
    const { name, entries } = value as Category;
    return `${quoted(name)}: ${entries.map((e) => e.label || e.query).join(', ') || 'no entries'}`;
  }
  if (value === undefined || value === null || value === '') return 'none';
  if (target[0] === 'item' && target[2] === 'tag') return 'tagged';
  if (target[0] === 'item' && target[2] === 'creators') return (value as Creator[]).map((c) => c.name).join(', ') || 'none';
  if (target[0] === 'item' && target[2] === 'file') {
    const name = (value as { name?: string; format?: string }).name;
    return name ?? (value as { format?: string }).format ?? 'attached';
  }
  if (target[0] === 'rating') return `${value} ★`;
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
