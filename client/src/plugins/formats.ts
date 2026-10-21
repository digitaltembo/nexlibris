import { CROSSPOINT_CONVERTERS } from '@nexlibris/crosspoint-tools/convert';
import { CROSSPOINT_FORMATS } from '@nexlibris/crosspoint-tools/formats';
import { registerConverters } from '@nexlibris/tools/formats/convert/converters';
import { registerFormats } from '@nexlibris/tools/formats/formats';

/**
 * Registers the formats and converters plugins add (see `Plugin.formats` and `converters`) with the
 * tools, apart from the plugins themselves, so a worker can load them without the plugins' connection
 * types and UI. Imported first by every entry point (`main.tsx`, `text.worker.ts`, test setup,
 * Storybook's preview), as modules read the formats when they load. A plugin's formats and converters
 * are listed in both.
 */
registerFormats(CROSSPOINT_FORMATS);
registerConverters(CROSSPOINT_CONVERTERS);
