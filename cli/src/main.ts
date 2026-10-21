import './environment';
import './plugins';
import { CONVERT_USAGE, parseCommand, USAGE, UsageError, type Command } from './args';
import { bookCover, bookInfo, conversionMatrix, convertBook, formatInfo, formatList, readBook, setMetadata, writeConversion, writeCover } from './commands';

/** The command line: `nexlibris <command> …` (see `USAGE` in `args.ts`). */

async function run(command: Command) {
  switch (command.command) {
    case 'help':
      return void process.stdout.write(command.topic === 'convert' ? `${CONVERT_USAGE}\n${conversionMatrix()}` : USAGE);
    case 'formats':
      return void process.stdout.write(formatList());
    case 'info': {
      const info = await bookInfo(await readBook(command.book));
      return void process.stdout.write(command.json ? `${JSON.stringify(info, null, 2)}\n` : formatInfo(info));
    }
    case 'cover': {
      const book = await readBook(command.book);
      if (command.output === '-') {
        const { data } = await bookCover(book);
        return void process.stdout.write(new Uint8Array(await data.arrayBuffer()));
      }
      return void console.log(`Wrote ${await writeCover(book, command.output)}`);
    }
    case 'convert': {
      const book = await readBook(command.book);
      if (command.output === '-') {
        const { data } = await convertBook(book, command.to, command.options);
        return void process.stdout.write(new Uint8Array(await data.arrayBuffer()));
      }
      return void console.log(`Wrote ${await writeConversion(book, command.to, command.options, command.output)}`);
    }
    case 'set':
      return void process.stdout.write(formatInfo(await setMetadata(await readBook(command.book), command.edits, command.output)));
  }
}

async function main() {
  try {
    await run(parseCommand(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    // The CLI's errors (`CliError`) and the tools' own (a DRM-protected book, a broken file) alike, plainly;
    // NEXLIBRIS_DEBUG=1 shows where they came from.
    console.error(e instanceof Error && !process.env.NEXLIBRIS_DEBUG ? e.message : e);
    process.exit(1);
  }
}

void main();
