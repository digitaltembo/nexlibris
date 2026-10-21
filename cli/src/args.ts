import { parseArgs, type ParseArgsConfig } from 'node:util';

export const USAGE = `nexlibris: books' files on the command line.

Usage:
  nexlibris info <book> [--json]
      Prints the book's metadata: title, creators, identifiers, tags, the rest, and its cover.
  nexlibris cover <book> [-o <image>]
      Writes the book's cover (by default to <book name>-cover.<ext> here; -o - for standard output).
  nexlibris convert <book> --to <format> [-o <book>] [--option <key>=<value>]...
      Converts the book, through more than one conversion if need be (MOBI to X4 EPUB, say), carrying its
      metadata over. Writes <book name>.<format> here by default (-o - for standard output). --option sets
      a converter's option; \`nexlibris formats\` lists them, and \`nexlibris convert --help\` which formats
      convert to which.
  nexlibris set <book> [-o <book>] [edits]
      Changes an EPUB's or Kindle book's (MOBI, AZW3, AZW) metadata, in place unless -o is given, and prints it
      as it now reads. Kindle books have no series or sorts. Edits:
        --title <title>           --title-sort <sort>     (a new title gets a new sort unless one is given)
        --author <name>...        --author-sort <sort>    (replace the authors; a new sort as with titles)
        --tag <tag>...            (replace the tags)      --add-tag <tag>...   --remove-tag <tag>...
        --series <name>           --series-index <n>      --publisher <name>
        --language <tag>          --published <date>      --description <html>
      Values can be changed and added, not removed: a field left empty keeps what the file says.
  nexlibris formats
      Lists the formats read and the conversions between them, with their options.
  nexlibris help [convert]

Formats:
  Metadata read (info):     EPUB (X4 and X3 EPUBs too), MOBI, AZW3, AZW, PDF, RTF, CBZ and CBR (from ComicInfo.xml);
                            TXT has none, so its title is its file name.
  Covers (cover):           EPUB, MOBI, AZW3, AZW, PDF (its first page drawn), CBZ and CBR (their first page).
                            TXT and RTF have none.
  Metadata written (set):   EPUB, MOBI, AZW3, AZW.
  Converted (convert):      see \`nexlibris convert --help\`.
  Read in the app:          EPUB, PDF, CBZ, CBR, TXT, RTF (Kindle books are converted to EPUB first).
`;

/** \`nexlibris convert --help\`: the command, then which formats convert to which (\`conversionMatrix\`). */
export const CONVERT_USAGE = `nexlibris convert <book> --to <format> [-o <book>] [--option <key>=<value>]...

Converts the book, carrying its metadata over, through more than one conversion if need be (MOBI to X4
EPUB by way of EPUB, say), by the way that loses least (rarely through plain text, which keeps only the words). Writes <book name>.<format>
here by default (-o - for standard output). --option sets a converter's option; \`nexlibris formats\`
lists them with their defaults.
`;

export interface Edits {
  title?: string;
  titleSort?: string;
  authors?: string[];
  authorSort?: string;
  tags?: string[];
  addTags: string[];
  removeTags: string[];
  series?: string;
  seriesIndex?: string;
  publisher?: string;
  language?: string;
  published?: string;
  description?: string;
}

export type Command =
  | { command: 'help'; topic?: 'convert' }
  | { command: 'formats' }
  | { command: 'info'; book: string; json: boolean }
  | { command: 'cover'; book: string; output?: string }
  | { command: 'convert'; book: string; to: string; output?: string; options: Record<string, string> }
  | { command: 'set'; book: string; output?: string; edits: Edits };

/** A command line that doesn't say what to do; shown with the usage. */
export class UsageError extends Error {
  name = 'UsageError';
}

/** `parseArgs` with the book as its one positional argument, its errors as usage errors. */
function parse<T extends NonNullable<ParseArgsConfig['options']>>(args: string[], options: T) {
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const [book, ...rest] = parsed.positionals;
  if (!book) throw new UsageError('Which book?');
  if (rest.length) throw new UsageError(`One book at a time (also given: ${rest.join(', ')}).`);
  return { book, values: parsed.values };
}

const OUTPUT = { output: { type: 'string', short: 'o' } } as const;
const text = { type: 'string' } as const;
const list = { type: 'string', multiple: true } as const;

export function parseCommand(argv: string[]): Command {
  const [command, ...args] = argv;
  const helping = command === 'help' || argv.includes('--help') || argv.includes('-h');
  if (helping && (command === 'convert' || (command === 'help' && args[0] === 'convert'))) return { command: 'help', topic: 'convert' };
  if (!command || helping) return { command: 'help' };
  switch (command) {
    case 'formats':
      if (args.length) throw new UsageError('`formats` takes no arguments.');
      return { command };
    case 'info': {
      const { book, values } = parse(args, { json: { type: 'boolean' } });
      return { command, book, json: !!values.json };
    }
    case 'cover': {
      const { book, values } = parse(args, OUTPUT);
      return { command, book, output: values.output };
    }
    case 'convert': {
      const { book, values } = parse(args, { ...OUTPUT, to: text, option: list });
      if (!values.to) throw new UsageError('Convert to what? Give --to <format>.');
      const options: Record<string, string> = {};
      for (const option of values.option ?? []) {
        const at = option.indexOf('=');
        if (at < 1) throw new UsageError(`An option is <key>=<value>, not ${option}.`);
        options[option.slice(0, at)] = option.slice(at + 1);
      }
      return { command, book, to: values.to, output: values.output, options };
    }
    case 'set': {
      const { book, values } = parse(args, {
        ...OUTPUT,
        title: text,
        'title-sort': text,
        author: list,
        'author-sort': text,
        tag: list,
        'add-tag': list,
        'remove-tag': list,
        series: text,
        'series-index': text,
        publisher: text,
        language: text,
        published: text,
        description: text,
      });
      const edits: Edits = {
        title: values.title,
        titleSort: values['title-sort'],
        authors: values.author,
        authorSort: values['author-sort'],
        tags: values.tag,
        addTags: values['add-tag'] ?? [],
        removeTags: values['remove-tag'] ?? [],
        series: values.series,
        seriesIndex: values['series-index'],
        publisher: values.publisher,
        language: values.language,
        published: values.published,
        description: values.description,
      };
      if (Object.values(edits).every((v) => v === undefined || (Array.isArray(v) && !v.length))) {
        throw new UsageError('Nothing to change: give an edit, such as --title.');
      }
      return { command, book, output: values.output, edits };
    }
    default:
      throw new UsageError(`There's no command ${command}.`);
  }
}
