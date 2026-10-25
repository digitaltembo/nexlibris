# @nexlibris/crosspoint-tools

Files for [CrossPoint](https://github.com/crosspoint-reader/crosspoint-reader) e-readers (the Xteink X4 and X3), built on [`@nexlibris/tools`](https://www.npmjs.com/package/@nexlibris/tools):

- `formats` and `convert`: the X4 and X3 EPUB formats and their converter from EPUB (the optimizer, `xteink/`, a port of the CrossPoint Calibre plugin's), registered with the tools' format registry.
- `sleepImage`: sleep images as screen-sized grayscale BMPs.
- `stardict`: StarDict dictionaries unpacked and checked.
- `fonts`: fonts sorted into families.
- `libraryIndex`: the reader's `/.crosspoint/library.idx`.

Modules are imported one by one, as with the tools:

```ts
import { registerFormats } from '@nexlibris/tools/formats/formats';
import { registerConverters } from '@nexlibris/tools/formats/convert/converters';
import { CROSSPOINT_FORMATS } from '@nexlibris/crosspoint-tools/formats';
import { CROSSPOINT_CONVERTERS } from '@nexlibris/crosspoint-tools/convert';

registerFormats(CROSSPOINT_FORMATS);
registerConverters(CROSSPOINT_CONVERTERS);
```

Like the tools, they're written for a bundler such as Vite (assets are imported as `?url`). Under Node, the `nexlibris` command ([`@nexlibris/cli`](https://www.npmjs.com/package/@nexlibris/cli)) runs them.

Part of [nexlibris](https://github.com/digitaltembo/nexlibris), under the MIT licence.
