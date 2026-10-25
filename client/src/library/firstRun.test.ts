import { applyOperations, createDevice, createLibrary } from '@nexlibris/common';
import { describe, expect, it } from 'vitest';
import { isNewLibrary } from './firstRun';

describe('isNewLibrary', () => {
  it('is a library nothing has been done to', () => {
    expect(isNewLibrary(createLibrary('Library'))).toBe(true);
  });

  it('isn’t once anything is set up, even without books', () => {
    const device = createDevice({ name: 'Reader', type: 'folder', settings: {} });
    const { library } = applyOperations(createLibrary('Library'), [{ type: 'addDevice', device }]);
    expect(Object.keys(library.items)).toHaveLength(0);
    expect(isNewLibrary(library)).toBe(false);
  });
});
