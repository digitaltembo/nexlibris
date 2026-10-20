import type { Converter } from '../formats/convert/converters';
import { CROSSPOINT_CONVERTERS } from './crosspoint/convert';
import { CROSSPOINT_FORMATS } from './crosspoint/formats';

/**
 * The formats and converters plugins add (see `Plugin.formats` and `converters`), gathered here
 * apart from the plugins themselves, so the format modules can read them without loading the
 * plugins' connection types and UI. A plugin's formats and converters are listed in both.
 */
export const PLUGIN_FORMATS = { ...CROSSPOINT_FORMATS };

export const PLUGIN_CONVERTERS: Converter[] = [...CROSSPOINT_CONVERTERS];
