import type { Device, Library } from '@nexlibris/common';
import { DEFAULT_FILE_NAME, expandPath, PLACEHOLDERS, templateProblems } from '../../devices/pathTemplate';
import { useMemo } from 'react';
import { settingOf, type DeviceTarget, type DeviceTool, type FilesType, type Inventory, type Plugin, type RemoteBook, type RemoteFile, type SettingField } from '../../devices/types';
import { listDevice, parentOf, syncFolders } from '../../devices/plan';
import { CrossPointTarget } from './client';
import { CROSSPOINT_CONVERTERS } from './convert';
import { CROSSPOINT_FORMATS } from './formats';
import { Dictionaries } from './tools/Dictionaries';
import { Fonts } from './tools/Fonts';
import { SleepImages } from './tools/SleepImages';
import { LIBRARY_INDEX_PATH, LibraryIndexError, parseLibraryIndex, recentBooks } from './libraryIndex';

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

/** Which reader it is: the X4 and X3 have different screens, so each has its own optimized EPUB. */
const MODEL: SettingField = {
  key: 'model',
  label: 'Model',
  default: 'X4',
  choices: [
    { value: 'X4', label: 'Xteink X4' },
    { value: 'X3', label: 'Xteink X3' },
  ],
  help: 'Books are sent as this reader’s optimized EPUB where they have one (Convert makes it), else as their EPUB.',
};

const modelOf = (device: Device): 'X4' | 'X3' => (settingOf(device, MODEL) === 'X3' ? 'X3' : 'X4');
const optimizedFor = (device: Device) => (modelOf(device) === 'X3' ? 'x3.epub' : 'x4.epub');

const settings: SettingField[] = [
  MODEL,
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
];

const setting = (device: Device, key: string) => {
  const value = device.settings[key];
  return typeof value === 'string' && value.trim() ? value.trim() : settings.find((s) => s.key === key)!.default;
};

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
  type: FilesType,
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

/** The reader at its connection's address, kept while the address is the same. */
function useReader(device: Device) {
  const address = setting(device, 'address');
  return useMemo(() => new CrossPointTarget(address), [address]);
}

const SleepTool = ({ device }: { device: Device }) => <SleepImages reader={useReader(device)} profile={modelOf(device)} />;
const DictionariesTool = ({ device }: { device: Device }) => <Dictionaries reader={useReader(device)} />;
const FontsTool = ({ device }: { device: Device }) => <Fonts reader={useReader(device)} />;

/** What else the reader keeps on its card, managed beside its books. */
function readerTools(): DeviceTool[] {
  return [
    { id: 'sleep', label: 'Sleep images', component: SleepTool },
    { id: 'dictionaries', label: 'Dictionaries', component: DictionariesTool },
    { id: 'fonts', label: 'Fonts', component: FontsTool },
  ];
}

/** A CrossPoint reader: its books read from its own index, sent as they're stored, its optimized EPUBs preferred. */
export const readerType: FilesType = {
  access: 'files',
  id: 'crosspoint.reader',
  label: 'CrossPoint Reader',
  activation: 'manual',
  read: true,
  write: { single: true },
  // The copy optimized for the reader where the book has one (made by Convert), else its EPUB.
  formats: (device) => [optimizedFor(device), 'epub'],
  preferred: (device) => [optimizedFor(device)],
  settings,
  folder: (device) => `/${setting(device, 'folder').replace(/^\/+|\/+$/g, '')}`,
  fileName: (device) => setting(device, 'fileName'),
  target: (device) => new CrossPointTarget(setting(device, 'address')),
  inventory: (device, target, library, listing) => readerInventory(device, readerType, target, library, listing),
  tools: readerTools(),
};

/** Xteink X4 and X3 readers running CrossPoint firmware, and the optimized EPUBs made for them. */
export const crosspoint: Plugin = {
  id: 'crosspoint',
  name: 'CrossPoint',
  connectionTypes: [readerType],
  formats: CROSSPOINT_FORMATS,
  converters: CROSSPOINT_CONVERTERS,
};
