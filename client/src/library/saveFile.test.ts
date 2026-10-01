import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveParts } from './saveFile';

const picker = window as { showSaveFilePicker?: unknown };

async function* parts() {
  yield new TextEncoder().encode('head');
  yield new Blob(['body']);
}

afterEach(() => {
  delete picker.showSaveFilePicker;
  vi.restoreAllMocks();
});

describe('saveParts in a browser', () => {
  it('writes each part to the file chosen in the save picker, without reading parts until then', async () => {
    const written: (Blob | Uint8Array)[] = [];
    const close = vi.fn(async () => undefined);
    let read = false;
    picker.showSaveFilePicker = vi.fn(async () => {
      expect(read).toBe(false);
      return { createWritable: async () => ({ write: async (p: Blob | Uint8Array) => void written.push(p), close, abort: vi.fn() }) };
    });
    const progress: number[] = [];
    const saved = await saveParts('backup.zip', () => ((read = true), parts()), { onProgress: (n) => progress.push(n) });
    expect(saved).toBe(true);
    expect(await new Blob(written as BlobPart[]).text()).toBe('headbody');
    expect(close).toHaveBeenCalled();
    expect(progress).toEqual([4, 8]);
  });

  it('reports a cancelled picker', async () => {
    picker.showSaveFilePicker = async () => {
      throw new DOMException('cancelled', 'AbortError');
    };
    const make = vi.fn(parts);
    expect(await saveParts('backup.zip', make)).toBe(false);
    expect(make).not.toHaveBeenCalled();
  });

  it('downloads the parts joined into one Blob where there is no picker', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:backup');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    expect(await saveParts('backup.zip', parts, { mimeType: 'application/zip' })).toBe(true);
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('application/zip');
    expect(await blob.text()).toBe('headbody');
    expect(click).toHaveBeenCalled();
  });
});
