import { createItem, MemoryStorage, StoredLibraryBackend } from '@nexlibris/common';
import type { Converter } from '@nexlibris/tools/formats/convert/converters';
import { describe, expect, it } from 'vitest';
import { availableConversions, conversionSource, convertItemFile, pathId } from './convert';

describe('conversion paths', () => {
  it('makes a format from the file whose conversion loses least, or from the format asked for', () => {
    const item = createItem({
      title: 'Dune',
      files: [
        { hash: 'm', size: 1, format: 'mobi' },
        { hash: 'e', size: 1, format: 'epub' },
      ],
    });
    expect(pathId(conversionSource(item, 'x4.epub')!.path)).toBe('xteink-x4');
    const fromMobi = conversionSource(item, 'x4.epub', 'mobi')!;
    expect([fromMobi.file.hash, pathId(fromMobi.path)]).toEqual(['m', 'kindle-epub+xteink-x4']);
    expect(conversionSource(item, 'epub')).toBeUndefined();
    expect(conversionSource(item, 'x4.epub', 'pdf')).toBeUndefined();
  });

  it('runs each step, records the path on the file made, and stops offering it once made', async () => {
    const backend = new StoredLibraryBackend(new MemoryStorage());
    const source = await backend.putFile(new Blob(['a']));
    const step = (id: string, from: string, to: string): Converter => ({
      id,
      from: [from as never],
      to: to as never,
      version: '2',
      fidelity: 1,
      run: async (data) => new Blob([await data.text(), to]),
    });
    const item = createItem({ title: 'Dune', files: [{ ...source, format: 'cbr' }] });
    const operation = await convertItemFile(backend, item, item.files[0]!, [step('one', 'cbr', 'cbz'), step('two', 'cbz', 'rtf')]);
    if (operation.type !== 'attachFile') throw new Error(operation.type);
    expect(operation.file).toMatchObject({ format: 'rtf', derivedFrom: { hash: source.hash, converter: 'one+two', converterVersion: '2+2' } });
    expect(await (await backend.getFile(operation.file.hash))!.text()).toBe('acbzrtf');

    const real = createItem({ title: 'Dune', files: [{ ...source, format: 'mobi' }] });
    const path = availableConversions(real, real.files[0]!).get('x4.epub')!;
    expect(path.map((c) => c.id)).toEqual(['kindle-epub', 'xteink-x4']);
    const made = { hash: 'x', size: 1, format: 'x4.epub', derivedFrom: { hash: source.hash, converter: pathId(path), converterVersion: path.map((c) => c.version).join('+') } };
    expect(availableConversions({ ...real, files: [...real.files, made] }, real.files[0]!).has('x4.epub')).toBe(false);
  });
});
