import { CROSSPOINT_CONVERTERS } from '@nexlibris/crosspoint-tools/convert';
import { CROSSPOINT_FORMATS } from '@nexlibris/crosspoint-tools/formats';
import { registerConverters } from '@nexlibris/tools/formats/convert/converters';
import { registerFormats } from '@nexlibris/tools/formats/formats';

/** The CrossPoint readers' formats and optimizer, as the app has them (`client/src/plugins/formats.ts`). */
registerFormats(CROSSPOINT_FORMATS);
registerConverters(CROSSPOINT_CONVERTERS);
