/**
 * Language codes as EPUBs want them (BCP 47: `en`, `en-US`), where Calibre and Open Library give
 * ISO 639-2's three letters (`eng`), for the common languages.
 */
const TWO_LETTER: Record<string, string> = {
  eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', rus: 'ru', jpn: 'ja',
  chi: 'zh', zho: 'zh', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', pol: 'pl', lat: 'la',
  gre: 'el', ell: 'el', ara: 'ar', heb: 'he', kor: 'ko', tur: 'tr', cze: 'cs', ces: 'cs', hun: 'hu', ukr: 'uk',
  hin: 'hi',
};

/** `eng` as `en`; a code with no two-letter form, or already in BCP 47, as it is. */
export const bcp47Language = (code: string) => TWO_LETTER[code.trim().toLowerCase()] ?? code.trim();

/** Whether two codes name the same language, whatever their forms or regions (`eng`, `en`, `en-US`). */
export const sameLanguage = (a: string, b: string) =>
  bcp47Language(a).split('-')[0]!.toLowerCase() === bcp47Language(b).split('-')[0]!.toLowerCase();
