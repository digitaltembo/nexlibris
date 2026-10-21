import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { bookFromItem, type ConvertContext, type ConvertItem } from '@nexlibris/tools/formats/convert/bookFromItem';
import { conversionPath, CONVERTERS, pathOptions, pathWithOptions, type Converter } from '@nexlibris/tools/formats/convert/converters';
import { extensionFor } from '@nexlibris/tools/formats/epubBuilder';
import { epubDrm, parseEpub } from '@nexlibris/tools/formats/epub';
import { writeEpubMetadata } from '@nexlibris/tools/formats/epubMetadata';
import { FORMATS, formatFromName, isEpub, isFormatId, KINDLE_FORMATS, stripExtension, type FormatId, type ParsedItem } from '@nexlibris/tools/formats/formats';
import { kindleToEpub, parseKindle } from '@nexlibris/tools/formats/kindle';
import { writeKindleMetadata } from '@nexlibris/tools/formats/kindleMetadata';
import { parseFile } from '@nexlibris/tools/formats/parseFile';
import { authorSortOf, mergeTags, normalizeValue, titleSortOf } from '@nexlibris/tools/metadata';
import type { OptionField } from '@nexlibris/tools/options';
import type { Edits } from './args';

/** Something the user can put right (a missing file, a format the tools don't read), said without a stack trace. */
export class CliError extends Error {
  name = 'CliError';
}

export interface Book {
  path: string;
  name: string;
  format: FormatId;
  data: Blob;
}

export async function readBook(path: string): Promise<Book> {
  const name = basename(path);
  const format = formatFromName(name);
  if (!format) throw new CliError(`${name}: not a format the tools read (\`nexlibris formats\` lists them).`);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (e) {
    throw new CliError(`Can’t read ${path}: ${e instanceof Error ? e.message : e}`);
  }
  return { path, name, format, data: new Blob([bytes], { type: FORMATS[format].mediaType }) };
}

/** Writes a file whole: to a temporary file beside it first, so a failed write leaves the old one as it was. */
async function writeWhole(path: string, data: Blob) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, new Uint8Array(await data.arrayBuffer()));
    await rename(temporary, path);
  } catch (e) {
    await rm(temporary, { force: true });
    throw e;
  }
}

export interface BookInfo {
  file: string;
  format: FormatId;
  title: string;
  creators: ParsedItem['creators'];
  identifiers: Record<string, string>;
  tags: string[];
  metadata: ParsedItem['metadata'];
  cover?: { mediaType: string; size: number };
  /** The EPUB's DRM, if it has any, which keeps its text from being read or rewritten. */
  drm?: string;
}

const infoOf = (book: Book, parsed: ParsedItem, drm?: string): BookInfo => ({
  file: book.name,
  format: book.format,
  title: parsed.title,
  creators: parsed.creators,
  identifiers: parsed.identifiers,
  tags: parsed.tags,
  metadata: parsed.metadata,
  ...(parsed.cover && { cover: { mediaType: parsed.cover.mediaType, size: parsed.cover.data.size } }),
  ...(drm && { drm }),
});

export async function bookInfo(book: Book): Promise<BookInfo> {
  const parsed = await parseFile(book.format, book.data, book.name);
  return infoOf(book, parsed, isEpub(book.format) ? await epubDrm(book.data, book.name) : undefined);
}

const kilobytes = (bytes: number) => (bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`);

/** A book's metadata for reading: a label and value a line. */
export function formatInfo(info: BookInfo): string {
  const rows: [string, string][] = [
    ['Title', info.title],
    ['Format', FORMATS[info.format].label],
  ];
  const authors = info.creators.filter((c) => c.role === 'aut').map((c) => c.name);
  if (authors.length) rows.push([authors.length > 1 ? 'Authors' : 'Author', authors.join(', ')]);
  const others = info.creators.filter((c) => c.role !== 'aut');
  if (others.length) rows.push(['Contributors', others.map((c) => `${c.name} (${c.role})`).join(', ')]);
  if (info.tags.length) rows.push(['Tags', info.tags.join(', ')]);
  for (const [scheme, id] of Object.entries(info.identifiers)) rows.push([scheme.toUpperCase(), id]);
  for (const [key, value] of Object.entries(info.metadata)) {
    if (value !== undefined) rows.push([key, typeof value === 'string' ? value : JSON.stringify(value)]);
  }
  rows.push(['Cover', info.cover ? `${info.cover.mediaType}, ${kilobytes(info.cover.size)}` : 'none']);
  if (info.drm) rows.push(['DRM', info.drm]);
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return rows.map(([label, value]) => `${`${label}:`.padEnd(width)}${value.replace(/\s*\n\s*/g, ' ')}`).join('\n') + '\n';
}

/** The book's cover, and where it goes by default: `<book name>-cover.<ext>` in the current folder. */
export async function bookCover(book: Book): Promise<{ data: Blob; defaultPath: string }> {
  const parsed = await parseFile(book.format, book.data, book.name);
  if (!parsed.cover) throw new CliError(`${book.name} has no cover.`);
  return { data: parsed.cover.data, defaultPath: `${stripExtension(book.name)}-cover.${extensionFor(parsed.cover.mediaType)}` };
}

export async function writeCover(book: Book, output?: string): Promise<string> {
  const { data, defaultPath } = await bookCover(book);
  const path = output ?? defaultPath;
  await writeWhole(path, data);
  return path;
}

export { conversionPath };

/**
 * Which formats convert to which, as a table: ● by one conversion, ○ by more than one (by way of EPUB), blank
 * not at all. Made from the converters registered, plugins' too.
 */
export function conversionMatrix(): string {
  const ids = Object.keys(FORMATS) as FormatId[];
  const width = Math.max(...ids.map((id) => id.length)) + 1;
  const cell = (text: string) => text.padStart(Math.ceil((width + text.length) / 2)).padEnd(width);
  const lines = ['Conversions (rows from, columns to; ● one conversion, ○ by way of others):', '', `${'from \\ to'.padEnd(width)} ${ids.map(cell).join('')}`];
  for (const from of ids) {
    const marks = ids.map((to) => {
      if (to === from) return cell('—');
      const path = conversionPath(from, to);
      return cell(!path ? '' : path.length === 1 ? '●' : '○');
    });
    lines.push(`${from.padEnd(width)} ${marks.join('')}`.trimEnd());
  }
  return lines.join('\n') + '\n';
}

/** Why a value won't do for an option, if it won't. */
function optionProblem(field: OptionField, value: string): string | undefined {
  if (field.kind === 'checkbox') return ['yes', 'no'].includes(value) ? undefined : 'yes or no';
  if (field.range) {
    const n = Number(value);
    const { min, max } = field.range;
    return Number.isInteger(n) && n >= min && n <= max ? undefined : `a whole number from ${min} to ${max}`;
  }
  const choices = field.choices?.map((c) => c.value);
  if (!choices) return undefined;
  const picked = field.kind === 'some' ? value.split(',').map((v) => v.trim()) : [value];
  return picked.every((v) => choices.includes(v)) ? undefined : `${field.kind === 'some' ? 'some of' : 'one of'} ${choices.join(', ')}`;
}

/** The converters of a path, with the options given: each takes those it has, and every option must be someone's. */
function withOptions(path: Converter[], options: Record<string, string>): Converter[] {
  const fields = pathOptions(path);
  for (const [key, value] of Object.entries(options)) {
    const field = fields.find((f) => f.key === key);
    if (!field) {
      const known = fields.map((f) => f.key);
      throw new CliError(`No conversion here takes ${key}${known.length ? ` (they take ${known.join(', ')})` : ''}.`);
    }
    const problem = optionProblem(field, value);
    if (problem) throw new CliError(`${key} is ${problem}, not ${value}.`);
  }
  return pathWithOptions(path, options);
}

/** What a conversion carries over: the book's metadata as its file has it. */
const convertItem = (parsed: ParsedItem): ConvertItem => ({
  title: parsed.title,
  creators: parsed.creators,
  identifiers: parsed.identifiers,
  tags: parsed.tags,
  metadata: parsed.metadata,
});

/** The book converted, and where it goes by default: `<book name>.<format>` in the current folder. */
export async function convertBook(book: Book, to: string, options: Record<string, string>): Promise<{ data: Blob; defaultPath: string }> {
  if (!isFormatId(to)) throw new CliError(`There's no format ${to} (\`nexlibris formats\` lists them).`);
  if (to === book.format) throw new CliError(`${book.name} is ${FORMATS[to].label} already.`);
  const path = conversionPath(book.format, to);
  if (!path) throw new CliError(`There's no way to convert ${FORMATS[book.format].label} to ${FORMATS[to].label}.`);
  const steps = withOptions(path, options);

  const parsed = await parseFile(book.format, book.data, book.name);
  const ctx: ConvertContext = { item: convertItem(parsed), ...(parsed.cover && { cover: parsed.cover }) };
  // Under Node the Kindle parser keeps a book's images and stylesheets in files, in the current folder unless told otherwise.
  const resources = await mkdtemp(join(tmpdir(), 'nexlibris-'));
  try {
    let data = book.data;
    let from = book.format;
    for (const step of steps) {
      data = step.id === 'kindle-epub' ? await kindleToEpub(data, ctx, { resourceSaveDir: resources }) : await step.run(data, from, ctx);
      from = step.to;
    }
    return { data, defaultPath: `${stripExtension(book.name)}.${to}` };
  } finally {
    await rm(resources, { recursive: true, force: true });
  }
}

export async function writeConversion(book: Book, to: string, options: Record<string, string>, output?: string): Promise<string> {
  if (output && resolve(output) === resolve(book.path)) throw new CliError('Converting would overwrite the book itself; give another -o.');
  const { data, defaultPath } = await convertBook(book, to, options);
  const path = output ?? defaultPath;
  await writeWhole(path, data);
  return path;
}

/** A book's metadata with the edits made. Titles and authors given without sorts get new sorts, as Calibre does. */
export function applyEdits(parsed: ParsedItem, edits: Edits): ConvertItem {
  const metadata = { ...parsed.metadata };
  const set = (key: string, value: string | undefined) => {
    if (value === undefined) return;
    const normalized = normalizeValue(key, value.trim());
    if (normalized !== undefined) metadata[key] = normalized;
  };
  const title = edits.title?.trim() || parsed.title;
  let creators = parsed.creators;
  if (edits.authors?.length) {
    creators = [...edits.authors.map((name) => ({ name: name.trim(), role: 'aut' })), ...parsed.creators.filter((c) => c.role !== 'aut')];
  }
  set('titleSort', edits.titleSort ?? (edits.title && metadata.titleSort !== undefined ? titleSortOf(title) : undefined));
  set('authorSort', edits.authorSort ?? (edits.authors?.length && metadata.authorSort !== undefined ? authorSortOf(edits.authors) : undefined));
  set('series', edits.series);
  if (edits.seriesIndex !== undefined) {
    const index = Number(edits.seriesIndex);
    if (!Number.isFinite(index)) throw new CliError(`A series index is a number, not ${edits.seriesIndex}.`);
    metadata.seriesIndex = index;
  }
  set('publisher', edits.publisher);
  set('language', edits.language);
  set('published', edits.published);
  set('description', edits.description);

  const removed = new Set(edits.removeTags.map((t) => t.trim().toLowerCase()));
  const tags = mergeTags([], [...(edits.tags ?? parsed.tags), ...edits.addTags]).filter((t) => !removed.has(t.toLowerCase()));
  return { title, creators, identifiers: parsed.identifiers, tags, metadata };
}

/** Edits a Kindle file has no place for. */
const KINDLE_LACKS: [keyof Edits, string][] = [
  ['series', '--series'],
  ['seriesIndex', '--series-index'],
  ['titleSort', '--title-sort'],
  ['authorSort', '--author-sort'],
];

/** Writes the edits into an EPUB or Kindle file, in place unless `output` says otherwise, and reads it back. */
export async function setMetadata(book: Book, edits: Edits, output?: string): Promise<BookInfo> {
  const kindle = KINDLE_FORMATS.includes(book.format);
  if (!kindle && !isEpub(book.format)) {
    throw new CliError(`Only EPUBs’ and Kindle books’ metadata can be changed, and ${book.name} is ${FORMATS[book.format].label}.`);
  }
  let parsed: ParsedItem;
  if (kindle) {
    const lacking = KINDLE_LACKS.filter(([key]) => edits[key] !== undefined).map(([, flag]) => flag);
    if (lacking.length) throw new CliError(`Kindle books have no place for ${lacking.join(' or ')}.`);
    parsed = await parseKindle(book.data, book.name);
  } else {
    const drm = await epubDrm(book.data, book.name);
    if (drm) throw new CliError(`${book.name} has DRM (${drm}), so it can’t be rewritten.`);
    parsed = await parseEpub(book.data, book.name, { cover: false });
  }
  const { identifiers: _identifiers, cover: _cover, ...metadata } = bookFromItem({ item: applyEdits(parsed, edits) });
  const written = kindle ? await writeKindleMetadata(book.data, metadata) : await writeEpubMetadata(book.data, metadata);
  const path = output ?? book.path;
  await writeWhole(path, written);
  const result = { ...book, path, name: basename(path), data: written };
  return infoOf(result, kindle ? await parseKindle(written, result.name) : await parseEpub(written, result.name));
}

/** The formats read and the conversions between them, with their options. */
export function formatList(): string {
  const lines = ['Formats:'];
  const ids = Object.keys(FORMATS) as FormatId[];
  const width = Math.max(...ids.map((id) => id.length)) + 2;
  for (const id of ids) lines.push(`  ${id.padEnd(width)}${FORMATS[id].label}`);
  lines.push('', 'Conversions:');
  for (const converter of CONVERTERS) {
    lines.push(`  ${converter.from.join(', ')} → ${converter.to}`);
    for (const field of converter.options ?? []) {
      const kind = field.kind === 'checkbox' ? 'yes/no' : field.range ? `${field.range.min}–${field.range.max}` : field.choices?.map((c) => c.value).join('|');
      lines.push(`      --option ${field.key}=<${kind ?? 'value'}>  ${field.label} (default ${field.default})`);
    }
  }
  return lines.join('\n') + '\n';
}
