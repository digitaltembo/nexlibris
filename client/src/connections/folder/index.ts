import type { Device, Library } from '@nexlibris/common';
import { expandPath, PLACEHOLDERS, templateProblems } from '../../devices/pathTemplate';
import { listDevice } from '../../devices/plan';
import { pickedChoices, settingOf, type FilesType, type SettingField } from '../../devices/types';
import { FORMATS, type FormatId } from '@nexlibris/tools/formats/formats';
import { canUseFolders, mayWrite, savedFolder } from '../../library/savedFolders';
import { describe, downloadBook, readManifest, writeManifest } from './manifest';
import { FolderTarget } from './target';

/**
 * A folder as a connection: a backup, or an external drive (a USB stick, a reader that mounts as
 * one). Books are written by a path template, each in every format chosen; what's there is read
 * back with the details in `.nexlibris-library.json` (`manifest.ts`). The folder itself is picked
 * on each computer and remembered there (`savedFolders.ts`), so browsers that can't be given
 * folders (Firefox, Safari, the Android app) can't use one.
 */

export const FOLDER_TYPE = 'folder.backup';

/** Where a folder connection's folder is remembered on this computer. */
export const folderKey = (deviceId: string) => `folder:${deviceId}`;

/** Where each book goes: the folders, then its file name, which gets each format as its extension. */
const SAVE_PATH: SettingField = {
  key: 'path',
  label: 'Save path',
  default: '<authorSort>/<title>',
  help: `Folders and file name, from ${PLACEHOLDERS.map((p) => `<${p.key}>`).join(', ')}; [ … ] for a part kept only when everything in it has a value. A book in several formats gets a file in each (Dune.epub, Dune.x4.epub).`,
  check: (path, _settings, library: Library) => {
    const problems = templateProblems(path);
    const sample = Object.values(library.items).find((i) => i.creators.length) ?? Object.values(library.items)[0];
    const { folder, fileName } = splitPath(path);
    return { problems, ...(sample && !problems.length && { example: expandPath(folder, fileName, sample, 'epub') }) };
  },
};

const FORMATS_SETTING: SettingField = {
  key: 'formats',
  label: 'Formats',
  kind: 'some',
  default: '',
  choices: (Object.keys(FORMATS) as FormatId[]).map((format) => ({ value: format, label: FORMATS[format].label })),
  help: 'Each book is written in every format it has, or, if you pick some, in every one of those it has.',
};

/** The folder's name, as it was picked, for showing it. */
export const FOLDER_NAME = 'folderName';

/** A save path's folders and file name: `<authorSort>/<title>` is the folder `<authorSort>` and the name `<title>`. */
function splitPath(path: string) {
  const trimmed = path.trim().replace(/^\/+|\/+$/g, '') || SAVE_PATH.default;
  const at = trimmed.lastIndexOf('/');
  return { folder: `/${at < 0 ? '' : trimmed.slice(0, at)}`, fileName: trimmed.slice(at + 1) };
}

/** The folder picked for a connection on this computer, once allowed to write to it (asked for if `ask`, which needs a click). */
export async function connectionFolder(device: Device, ask = true): Promise<FileSystemDirectoryHandle> {
  const handle = await savedFolder(folderKey(device.id));
  if (!handle) throw new Error(`This computer doesn’t know where ${device.name} is. Edit it and choose its folder.`);
  if (!(await mayWrite(handle, ask))) throw new Error(`nexlibris wasn’t allowed to use the folder “${handle.name}”.`);
  return handle;
}

/**
 * Why a folder connection isn't active here, if it isn't: no folder chosen on this computer, or it's
 * gone (a drive unplugged). Without permission to look (a browser asks again after a restart), it's
 * taken to be there; using it asks.
 */
async function folderMissing(device: Device): Promise<string | undefined> {
  const handle = await savedFolder(folderKey(device.id));
  if (!handle) return 'No folder chosen on this device';
  if ((await handle.queryPermission?.({ mode: 'read' })) !== 'granted') return undefined;
  try {
    await handle.values().next();
    return undefined;
  } catch {
    return `The folder “${handle.name}” isn’t there`;
  }
}

export const folderType: FilesType = {
  access: 'files',
  id: FOLDER_TYPE,
  label: 'Folder',
  read: true,
  write: { single: true },
  unavailable: () => (canUseFolders() ? undefined : 'This browser can’t be given folders: use Chrome, Edge or the desktop app.'),
  activation: folderMissing,
  formats: (device) => pickedChoices(device, FORMATS_SETTING) as FormatId[],
  settings: [SAVE_PATH, FORMATS_SETTING],
  pickFolder: true,
  fullExtension: true,
  everyFormat: true,
  folder: (device) => splitPath(settingOf(device, SAVE_PATH)).folder,
  fileName: (device) => splitPath(settingOf(device, SAVE_PATH)).fileName,
  target: (device) => new FolderTarget(() => connectionFolder(device)),
  async inventory(device, target, library, listing) {
    const files = target instanceof FolderTarget ? await target.walk() : (listing ?? (await listDevice(device, folderType, target, library)).files);
    const manifest = await readManifest(target);
    const books = files.map((file) => describe(manifest, file)).sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''));
    return { books, ...(!manifest && files.length > 0 && { note: 'This folder has no nexlibris manifest yet, so its books are known by their file names.' }) };
  },
  download: (_device, target, book, backend) => downloadBook(target, book.path, backend),
  afterSync: (device, target, library, backend) => writeManifest(device, target, library, backend),
};
