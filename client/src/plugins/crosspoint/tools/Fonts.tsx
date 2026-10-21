import { useState } from 'react';
import { Badge, Button } from '../../../styles/ui';
import type { FontFamily, ReaderSetting } from '../client';
import { FONT_ROOT, isCpfont, sortFonts } from '@nexlibris/crosspoint-tools/fonts';
import { Actions, Note, PickButton, Rows, sizeLabel, Status, useReaderState, type ToolProps } from './shared';

interface FontsState {
  families: FontFamily[];
  /** The reader's font family setting: built-in fonts, then the SD card's. */
  setting?: ReaderSetting;
}

const ACCEPT = '.cpfont,.ttf,.otf,.ttc';

/** Sizes as the reader lists them: points, or "any size" for TTF/OTF/TTC families. */
const sizesLabel = (sizes: number[]) => (sizes.includes(0) ? 'TTF/OTF, 12–18 pt' : `${sizes.join(', ')} pt`);

/** The reader's reading fonts: the one in use chosen, families added (.cpfont, TTF/OTF/TTC) and removed. */
export function Fonts({ reader }: ToolProps) {
  const [problems, setProblems] = useState<string[]>([]);
  const { data, error, busy, run } = useReaderState<FontsState>(async () => {
    const [families, settings] = await Promise.all([reader.fonts(), reader.settings().catch(() => [])]);
    const setting = settings.find((s) => s.key === 'fontFamily');
    return { families: families.sort((a, b) => a.name.localeCompare(b.name)), ...(setting && { setting }) };
  });

  const options = data?.setting?.options ?? [];
  const inUse = options[Number(data?.setting?.value)];
  const builtIn = options.filter((name) => !data?.families.some((f) => f.name === name));
  const use = (name: string) =>
    void run(`Switching to ${name}…`, () => reader.changeSettings({ fontFamily: options.indexOf(name) }));

  const add = (picked: { path: string; data: Blob }[]) =>
    void run('Adding fonts…', async (say) => {
      const { uploads, skipped } = sortFonts(picked);
      const found = skipped.map((name) => `${name}: not a font file (.cpfont, .ttf, .otf or .ttc).`);
      for (const [i, font] of uploads.entries()) {
        say(`Adding ${font.family}: ${font.name} (${i + 1} of ${uploads.length})…`);
        try {
          if (font.kind === 'cpfont') {
            if (!(await isCpfont(font.data))) throw new Error('not a CrossPoint font');
            await reader.uploadFont(font.family, font.name, font.data);
          } else {
            await reader.makeFolder('/', FONT_ROOT.slice(1));
            await reader.makeFolder(FONT_ROOT, font.family);
            await reader.upload(`${FONT_ROOT}/${font.family}/${font.name}`, font.data);
          }
        } catch (e) {
          found.push(`${font.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      setProblems(found);
    });

  const remove = (family: FontFamily) => void run(`Removing ${family.name}…`, () => reader.deleteFont(family.name));

  return (
    <>
      <Note>
        Reading fonts on the SD card. Add CrossPoint’s .cpfont files (one per size; fonts made for it are in the
        crosspoint-fonts project, or the reader can download them itself in Settings → Reader → Manage Fonts), or TTF,
        OTF and TTC files, which only readers with external RAM can use. Pick a folder to add a family whose styles are
        separate files.
      </Note>
      <Actions>
        <PickButton accept={ACCEPT} disabled={!!busy} onPick={add}>
          Add font files…
        </PickButton>
        <PickButton folder disabled={!!busy} onPick={add}>
          Add a folder…
        </PickButton>
      </Actions>
      <Status busy={busy} error={error} problems={problems} />
      {!data && !error && <Note>Reading the reader…</Note>}
      {data && (
        <Rows>
          {builtIn.map((name) => (
            <li key={`builtin:${name}`}>
              <div>
                <strong>{name}</strong>
                <small>Built in</small>
              </div>
              {name === inUse ? (
                <Badge>In use</Badge>
              ) : (
                <Button $variant="secondary" $size="small" disabled={!!busy} onClick={() => use(name)}>
                  Use
                </Button>
              )}
            </li>
          ))}
          {data.families.map((family) => (
            <li key={family.name}>
              <div>
                <strong>{family.name}</strong>
                <small>
                  {sizesLabel(family.sizes)} · {sizeLabel(family.files.reduce((n, f) => n + f.size, 0))}
                </small>
              </div>
              {family.name === inUse ? (
                <Badge>In use</Badge>
              ) : (
                options.includes(family.name) && (
                  <Button $variant="secondary" $size="small" disabled={!!busy} onClick={() => use(family.name)}>
                    Use
                  </Button>
                )
              )}
              <Button $variant="secondary" $size="small" disabled={!!busy} onClick={() => remove(family)}>
                Remove
              </Button>
            </li>
          ))}
        </Rows>
      )}
    </>
  );
}
