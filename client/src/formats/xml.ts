/**
 * Parses an XML document that has already been decoded to a string, or
 * returns undefined if it isn't well-formed.
 *
 * The XML declaration is dropped first: once decoded, its encoding means
 * nothing, and not every DOM accepts every valid form of it (happy-dom
 * rejects `<?xml version='1.0'?>` in single quotes, as Calibre writes it).
 */
export function parseXml(text: string): Document | undefined {
  const doc = new DOMParser().parseFromString(text.replace(/^﻿?\s*<\?xml[^?]*\?>/, ''), 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? undefined : doc;
}
