import type { MetadataValue } from '@nexlibris/common';

/**
 * Metadata values are edited as text. Lists of strings are shown
 * comma-separated; other non-string values are shown as JSON.
 */
export function metadataToText(value: MetadataValue | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (isStringList(value)) return value.join(', ');
  return JSON.stringify(value);
}

/**
 * Parses edited text back into a value, keeping the type of the previous value
 * where possible so e.g. `seriesIndex` stays a number. New keys become strings.
 */
export function textToMetadata(text: string, previous: MetadataValue | undefined): MetadataValue {
  if (previous === undefined || typeof previous === 'string') return text;
  if (isStringList(previous)) {
    return text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  try {
    return JSON.parse(text) as MetadataValue;
  } catch {
    return text;
  }
}

function isStringList(value: MetadataValue): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}
