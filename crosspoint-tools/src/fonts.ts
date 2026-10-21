/**
 * Fonts for CrossPoint (crosspoint-reader's docs/sd-card-fonts.md). `.cpfont` files, made for the
 * reader at fixed sizes (`Literata_12.cpfont`), go through its font API into a family; TTF, OTF and
 * TTC files are copied into `/fonts/<family>/`, and only readers with external RAM use those.
 */

export const FONT_ROOT = '/fonts';

export interface FontUpload {
  family: string;
  /** `.cpfont` through the font API; anything else copied into the family's folder. */
  kind: 'cpfont' | 'direct';
  name: string;
  data: Blob;
}

/** A family name as the reader takes it: letters, digits, hyphens and underscores. */
export const familyName = (text: string) => text.replace(/\s+/g, '_').replace(/[^\w-]+/g, '').slice(0, 48);

const STYLES = /[-_ ]?(regular|bold|italic|bolditalic|bold[-_ ]?italic|book|medium|light|semibold|oblique)$/i;

/**
 * Sorts picked font files into families. A `.cpfont`'s family is its name without the size
 * (`Literata_12`); a TTF/OTF/TTC's is its folder's, when picked in one, else its name without the
 * style (`Bookerly-Bold`). Other files are reported.
 */
export function sortFonts(picked: { path: string; data: Blob }[]): { uploads: FontUpload[]; skipped: string[] } {
  const uploads: FontUpload[] = [];
  const skipped: string[] = [];
  for (const { path, data } of picked) {
    const parts = path.split('/');
    const name = parts.at(-1)!;
    const folder = parts.length > 1 ? parts.at(-2)! : undefined;
    if (/\.cpfont$/i.test(name)) {
      const family = familyName(name.replace(/\.cpfont$/i, '').replace(/_\d+$/, ''));
      // The reader takes .cpfont names of letters, digits, hyphens and underscores.
      if (family) uploads.push({ family, kind: 'cpfont', name: name.replace(/ /g, '_'), data });
      else skipped.push(name);
    } else if (/\.(ttf|otf|ttc)$/i.test(name)) {
      const family = familyName(folder ?? name.replace(/\.[^.]+$/, '').replace(STYLES, ''));
      if (family) uploads.push({ family, kind: 'direct', name, data });
      else skipped.push(name);
    } else if (!name.startsWith('.')) {
      skipped.push(name);
    }
  }
  return { uploads, skipped };
}

/** Whether a file starts as a `.cpfont` must (the reader checks the same). */
export async function isCpfont(data: Blob): Promise<boolean> {
  const head = new Uint8Array(await data.slice(0, 8).arrayBuffer());
  return new TextDecoder().decode(head) === 'CPFONT\0\0';
}
