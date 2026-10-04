import { createItem } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { bookShape } from './Bookshelf';

describe('bookShape', () => {
  it('keeps a book’s size, thickens it by its pages and colours it by its cover', () => {
    const item = createItem({ title: 'Dune', metadata: { pages: 412, coverColor: '#f0e0b0' } });
    expect(bookShape(item)).toEqual(bookShape(item));
    expect(bookShape(item)).toMatchObject({ thickness: 32, color: '#f0e0b0', ink: '#1d1a16' });
    expect(bookShape({ ...item, metadata: { pages: 2000, coverColor: '#202040' } })).toMatchObject({ thickness: 52, ink: '#f6f0e4' });
    const plain = bookShape(createItem({ title: 'Plain' }));
    expect(plain.height).toBeGreaterThanOrEqual(150);
    expect(plain.height).toBeLessThanOrEqual(196);
    expect(plain.color).toMatch(/^#[0-9a-f]{6}$/);
  });
});
