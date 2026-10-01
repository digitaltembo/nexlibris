import { describe, expect, it } from 'vitest';
import { parseXml } from './xml';

describe('parseXml', () => {
  it('accepts any valid XML declaration, and a byte order mark', () => {
    for (const declaration of [`<?xml version='1.0' encoding='utf-8'?>`, '<?xml version="1.0"?>', '﻿<?xml version="1.0"?>', '']) {
      expect(parseXml(`${declaration}\n<package><title>A</title></package>`)?.querySelector('title')?.textContent).toBe('A');
    }
  });

  it('returns undefined for malformed XML', () => {
    expect(parseXml('<package><title>A</package>')).toBeUndefined();
  });
});
