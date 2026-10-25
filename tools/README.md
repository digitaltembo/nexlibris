# @nexlibris/tools

Working with books' files, in the browser and under Node: their metadata and covers, writing metadata back, converting between formats, their text for full-text search, cover colours, and zips written and read a piece at a time. It's standalone (no other nexlibris package, no React), so other projects can use it.

Modules are imported one by one, so heavy ones load only where they're used:

```ts
import { parseFile } from '@nexlibris/tools/formats/parseFile';
import { convertersFrom } from '@nexlibris/tools/formats/convert/converters';
```

Under Node the tools need what a browser gives them (a DOM parser, `fetch` of local files and, for images, a canvas); `cli/src/environment.ts` and `cli/src/canvas.ts` in nexlibris show how.

## Formats

- **Metadata read** (`formats/parseFile.ts`): EPUB (and its variants, such as X4 and X3 EPUBs), MOBI, AZW3 and AZW (from their headers), PDF (its document info), RTF (its `\info`), CBZ and CBR (from ComicInfo.xml). TXT has none, so its title is its file name.
- **Covers** (with the metadata): EPUB, MOBI, AZW3 and AZW, PDF (its first page drawn, which needs a canvas), CBZ and CBR (their first page). TXT and RTF have none.
- **Metadata written:** EPUB (`formats/epubMetadata.ts`), MOBI, AZW3 and AZW (`formats/kindleMetadata.ts`; no series or sorts, which Kindle books can't hold).
- **Text for full-text search** (`fulltext/extract.ts`): EPUB, PDF, TXT and RTF; EPUB and TXT in a worker too, PDF and RTF only in the page.
- **Converted:** see Conversions, below.

Reading books is left to their users (nexlibris's reader opens EPUB, Kindle books, PDF, CBZ, CBR, TXT and RTF).

## Conversions

The converters in `formats/convert/converters.ts` (`CONVERTERS`), each from the rows to a column:

| from \ to | epub | pdf | cbz | cbr | txt | rtf | mobi | azw3 | azw |
|---|---|---|---|---|---|---|---|---|---|
| **epub** | — | ● | | | ● | ● | ● | ● | ● |
| **pdf** | ● | — | | | | | | | |
| **cbz** | ● | | — | ● | | | | | |
| **cbr** | ● | | ● | — | | | | | |
| **txt** | ● | | | | — | | | | |
| **rtf** | ● | | | | | — | | | |
| **mobi**, **azw3**, **azw** | ● | | | | | | | | |

EPUB here means EPUB and its variants (`EPUB_FORMATS`), plugins' too, such as CrossPoint's X4 and X3 EPUBs, which `@nexlibris/crosspoint-tools` adds with their converter from EPUB (`registerFormats`, `registerConverters`). A conversion between other formats goes by way of EPUB, chained by the most kept (each converter's `fidelity`, 1 for nothing of value lost; a chain's `pathFidelity` is the product of its steps'; `conversionPath` and `conversionPaths` in `formats/convert/converters.ts`; `nexlibris convert --help` prints the whole table).

Converters with options list them as `OptionField`s (`options`) and make a converter with values given (`withOptions`); the options are part of its `version`:

- **EPUB to PDF** (`convert/pdf/`): typeset with pdf-lib, Literata and JetBrains Mono embedded; page size, page numbers, book and chapter headers, chapter numbers, roman numerals.
- **PDF to EPUB** (`convert/pdfText/`): a PDF's text layer reflowed, after scan2epub: running heads and page numbers left out, paragraphs and words broken across lines and pages joined again, chapters from the PDF's bookmarks or its chapter openings; options for where chapters come from, which side the first page is, and each side's margins to ignore. There's no OCR, so a PDF without a text layer is refused.
