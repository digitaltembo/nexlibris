import type { Device, Library } from '@nexlibris/common';
import { DEFAULT_FILE_NAME, expandPath, PLACEHOLDERS, templateProblems } from '../../devices/pathTemplate';
import { useMemo } from 'react';
import type { CatalogType, DeviceTarget, DeviceTool, DeviceType, Inventory, Plugin, RemoteBook, RemoteFile, SettingField } from '../../devices/types';
import { embedMetadata } from '../../devices/embedMetadata';
import { listDevice, parentOf, syncFolders } from '../../devices/plan';
import { xteinkConverter } from '../../formats/convert/converters';
import { DEFAULT_OPTIMIZE_OPTIONS, type OptimizeOptions } from '../../formats/convert/xteink/options';
import { HOSTED_AT } from '../opds';
import { CrossPointTarget } from './client';
import { Dictionaries } from './tools/Dictionaries';
import { Fonts } from './tools/Fonts';
import { SleepImages } from './tools/SleepImages';
import { LIBRARY_INDEX_PATH, LibraryIndexError, parseLibraryIndex, recentBooks } from './libraryIndex';

/** How the optimized copy is made: a reader's settings, and those of a catalog for one. */
const optimizerSettings: SettingField[] = [
  {
    key: 'quality',
    label: 'Image quality',
    default: String(DEFAULT_OPTIMIZE_OPTIONS.quality),
    range: { min: 1, max: 100 },
    help: 'JPEG quality of images in the optimized copy. Lower is smaller and faster to open.',
  },
  {
    key: 'grayscale',
    label: 'Images',
    default: 'yes',
    choices: [
      { value: 'yes', label: 'Grayscale' },
      { value: 'no', label: 'Keep colour' },
    ],
    help: 'The screen is grayscale; colour images are larger for no gain on it.',
  },
  {
    key: 'autoCrop',
    label: 'Crop image margins',
    default: 'no',
    choices: [
      { value: 'no', label: 'No' },
      { value: 'yes', label: 'Yes' },
    ],
    help: 'Trims plain margins so illustrations fill the screen. Sparse pages can end up zoomed a lot.',
  },
  {
    key: 'splitParagraphs',
    label: 'Split long paragraphs',
    default: 'yes',
    choices: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
    help: 'Splits very long paragraphs so the reader has the memory to lay them out.',
  },
  {
    key: 'splitChapters',
    label: 'Split long chapters',
    default: 'no',
    choices: [
      { value: 'no', label: 'No' },
      { value: 'yes', label: 'Yes' },
    ],
    help: 'Splits chapters into ~7 KB files, each shown as its own chapter. Only older firmware needs it.',
  },
];

/** What can go in the folder and file name. */
const PLACEHOLDER_HELP = `${PLACEHOLDERS.map((p) => `<${p.key}>`).join(', ')}; <authorSort:1> for its first letter; [ … ] for a part kept only when everything in it has a value, as in [<series>/]. Books move when this changes.`;

/** A template's problems, and where a book from the library would go by it. */
function checkTemplates(folder: string, fileName: string, library: Library) {
  const items = Object.values(library.items);
  // A book with a series and an author shows the most.
  const sample = items.find((i) => i.metadata.series && i.creators.length) ?? items.find((i) => i.creators.length) ?? items[0];
  const problems = templateProblems(folder);
  return { problems, ...(sample && !problems.length && { example: expandPath(folder, fileName, sample, 'epub') }) };
}

const settings: SettingField[] = [
  {
    key: 'address',
    label: 'Address',
    default: 'http://crosspoint.local',
    help: 'Shown on the reader in File Transfer mode. Use its IP address if crosspoint.local doesn’t work.',
  },
  {
    key: 'folder',
    label: 'Folder',
    default: '/Books',
    help: `Where books go on the SD card. Put the book’s details in with ${PLACEHOLDER_HELP}`,
    check: (folder, values, library) => checkTemplates(folder, values.fileName?.trim() || DEFAULT_FILE_NAME, library),
  },
  {
    key: 'fileName',
    label: 'File name',
    default: DEFAULT_FILE_NAME,
    help: 'Books’ file names, without the extension, from the same details. A clash gets “(2)”.',
    check: (fileName) => ({ problems: templateProblems(fileName) }),
  },
  {
    key: 'catalogUrl',
    label: 'Catalog URL',
    default: '',
    help: 'Where you host an OPDS catalog for this reader (an “OPDS catalog for X4” connection, say), if you do. Syncing adds it to the reader’s OPDS libraries.',
  },
  ...optimizerSettings,
];

const setting = (device: Device, key: string) => {
  const value = device.settings[key];
  return typeof value === 'string' && value.trim() ? value.trim() : settings.find((s) => s.key === key)!.default;
};

/** The optimizer options a device's settings ask for. Changing them makes the next sync remake its optimized copies. */
export function optimizeOptions(device: Device): OptimizeOptions {
  const quality = Math.round(Number(setting(device, 'quality')));
  return {
    quality: quality >= 1 && quality <= 100 ? quality : DEFAULT_OPTIMIZE_OPTIONS.quality,
    grayscale: setting(device, 'grayscale') !== 'no',
    autoCrop: setting(device, 'autoCrop') === 'yes',
    splitParagraphs: setting(device, 'splitParagraphs') !== 'no',
    splitChapters: setting(device, 'splitChapters') === 'yes',
  };
}

/** Files the reader's index takes (`isBookName` in its LibraryBuilder), for listing ones it doesn't have yet. */
const isBookName = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return !name.startsWith('.') && /\.(epub|txt|md|xtc)$/i.test(name);
};

/**
 * Everything on the card, from the reader's own index (`library.idx`), which has each book's
 * metadata, newest first. The reader rebuilds it when its library is opened, so files sent since
 * are added from a listing of the sync folders, and indexed books gone from those folders are
 * left out. Without a readable index, the folders' files are all there is.
 */
export async function readerInventory(
  device: Device,
  type: DeviceType,
  target: DeviceTarget,
  library?: Library,
  listing?: RemoteFile[],
): Promise<Inventory> {
  const listed = listing ?? (await listDevice(device, type, target, library)).files;
  let indexed: RemoteBook[] = [];
  let note: string | undefined;
  try {
    const data = await target.download!(LIBRARY_INDEX_PATH);
    indexed = recentBooks(parseLibraryIndex(await data.arrayBuffer())).map((book) => ({
      path: book.path,
      size: book.size,
      title: book.title,
      ...(book.author && { author: book.author }),
      ...(book.series && { series: book.series, seriesIndex: book.seriesIndex }),
      ...(book.tags.length > 0 && { tags: book.tags }),
      ...(book.modified && { modified: book.modified }),
    }));
  } catch (e) {
    note =
      e instanceof LibraryIndexError
        ? 'The reader’s library index is from other firmware, so only the sync folders are listed. Opening the library on the reader rebuilds it.'
        : 'The reader’s library index couldn’t be read, so only the sync folders are listed. Opening the library on the reader makes one.';
  }
  // Books the index has in a folder just listed, but that aren't there now, have gone since it was built.
  const folders = syncFolders(device, type, library);
  const present = new Set(listed.map((file) => file.path));
  const books = indexed.filter((book) => !folders.has(parentOf(book.path)) || present.has(book.path));
  const known = new Set(books.map((book) => book.path));
  const fresh = listed.filter((file) => !known.has(file.path) && isBookName(file.path));
  return { books: [...fresh, ...books], ...(note && { note }) };
}

function deviceType(id: string, label: string, profile: 'X4' | 'X3'): DeviceType {
  const optimized = profile === 'X4' ? 'x4.epub' : 'x3.epub';
  const type: DeviceType = {
    id,
    label,
    // The copy optimized for the device, made from the EPUB when the book doesn't have one yet.
    formats: [optimized, 'epub'],
    makes: (device) => xteinkConverter(profile, optimizeOptions(device)),
    settings,
    folder: (device) => `/${setting(device, 'folder').replace(/^\/+|\/+$/g, '')}`,
    fileName: (device) => setting(device, 'fileName'),
    prepare: embedMetadata,
    catalog: (device) => {
      const url = setting(device, 'catalogUrl');
      return url ? { name: device.name, url } : undefined;
    },
    target: (device) => new CrossPointTarget(setting(device, 'address')),
    inventory: (device, target, library, listing) => readerInventory(device, type, target, library, listing),
    tools: readerTools(profile),
  };
  return type;
}

/** The reader at its connection's address, kept while the address is the same. */
function useReader(device: Device) {
  const address = setting(device, 'address');
  return useMemo(() => new CrossPointTarget(address), [address]);
}

const SleepTool = ({ device, profile }: { device: Device; profile: 'X4' | 'X3' }) => (
  <SleepImages reader={useReader(device)} profile={profile} />
);
const DictionariesTool = ({ device }: { device: Device }) => <Dictionaries reader={useReader(device)} />;
const FontsTool = ({ device }: { device: Device }) => <Fonts reader={useReader(device)} />;

/** What else the reader keeps on its card, managed beside its books. */
function readerTools(profile: 'X4' | 'X3'): DeviceTool[] {
  return [
    { id: 'sleep', label: 'Sleep images', component: ({ device }) => <SleepTool device={device} profile={profile} /> },
    { id: 'dictionaries', label: 'Dictionaries', component: DictionariesTool },
    { id: 'fonts', label: 'Fonts', component: FontsTool },
  ];
}

/** A static OPDS catalog for the reader to browse: each book's optimized copy and its EPUB. */
function catalogType(id: string, label: string, profile: 'X4' | 'X3'): CatalogType {
  return {
    kind: 'catalog',
    id,
    label,
    formats: [profile === 'X4' ? 'x4.epub' : 'x3.epub', 'epub'],
    makes: (device) => xteinkConverter(profile, optimizeOptions(device)),
    settings: [HOSTED_AT, ...optimizerSettings],
    prepare: embedMetadata,
  };
}

/** Xteink X4 and X3 readers running CrossPoint firmware, and OPDS catalogs made for them. */
export const crosspoint: Plugin = {
  id: 'crosspoint',
  name: 'CrossPoint',
  connectionTypes: [
    deviceType('crosspoint.x4', 'Xteink X4 (CrossPoint)', 'X4'),
    deviceType('crosspoint.x3', 'Xteink X3 (CrossPoint)', 'X3'),
    catalogType('crosspoint.x4-catalog', 'OPDS catalog for X4', 'X4'),
    catalogType('crosspoint.x3-catalog', 'OPDS catalog for X3', 'X3'),
  ],
};
