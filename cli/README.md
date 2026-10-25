# @nexlibris/cli

`nexlibris`, books' files on the command line: their metadata and covers, conversion between formats (EPUB, Kindle books, PDF, RTF, comics, CrossPoint's X4 and X3 EPUBs) and metadata edits. It runs the same tools as the [nexlibris](https://github.com/digitaltembo/nexlibris) app.

```sh
npm install -g @nexlibris/cli
nexlibris info Dune.epub
nexlibris convert Dune.epub --to azw3
nexlibris set Dune.epub --series Dune --series-index 1
nexlibris help
```

Needs Node 24 or later. Under the MIT licence.
