import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { Button, SmallSelect } from '../../../styles/ui';
import type { Entry, ReaderSetting } from '../client';
import {
  makeSleepImage,
  SCREEN,
  SLEEP_COVER_CUSTOM,
  SLEEP_CUSTOM,
  SLEEP_FALLBACK_FOLDER,
  SLEEP_FILE,
  SLEEP_FOLDER,
  sleepImageName,
  type Placement,
  type Profile,
} from '@nexlibris/crosspoint-tools/sleepImage';
import { Actions, Note, PickButton, Status, useReaderState, type ToolProps } from './shared';
import { t } from '../../../i18n';

interface SleepImage {
  path: string;
  size: number;
  /** Where it is, when that matters: the single image, or the fallback folder. */
  where?: 'single' | 'fallback';
}

interface SleepState {
  images: SleepImage[];
  setting?: ReaderSetting;
}

const isBmp = (e: Entry) => !e.isDirectory && !e.name.startsWith('.') && /\.bmp$/i.test(e.name);

/** Pictures already fetched from the reader (they're big, and it's slow), by path and size. */
const fetched = new Map<string, string>();

const Grid = styled.ul`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 12px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    font-size: 0.8em;
  }

  small {
    overflow: hidden;
    color: var(--muted);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
`;

const Picture = styled.div<{ $ratio: string }>`
  aspect-ratio: ${(p) => p.$ratio};
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
`;

/** The reader's sleep images: shown, added from pictures (made into screen-sized BMPs), and removed. */
export function SleepImages({ reader, profile }: ToolProps & { profile: Profile }) {
  const [placement, setPlacement] = useState<Placement>('fill');
  const { data, error, busy, run } = useReaderState<SleepState>(async () => {
    const [root, folder, fallback, settings] = await Promise.all([
      reader.entries('/'),
      reader.entries(SLEEP_FOLDER),
      reader.entries(SLEEP_FALLBACK_FOLDER),
      reader.settings().catch(() => []),
    ]);
    const single = root.find((e) => !e.isDirectory && e.name.toLowerCase() === SLEEP_FILE.slice(1));
    const images: SleepImage[] = [
      ...(single ? [{ path: SLEEP_FILE, size: single.size, where: 'single' as const }] : []),
      ...folder.filter(isBmp).map((e) => ({ path: `${SLEEP_FOLDER}/${e.name}`, size: e.size })),
      ...fallback.filter(isBmp).map((e) => ({ path: `${SLEEP_FALLBACK_FOLDER}/${e.name}`, size: e.size, where: 'fallback' as const })),
    ];
    const setting = settings.find((s) => s.key === 'sleepScreen');
    return { images, ...(setting && { setting }) };
  });

  const add = (files: { name: string; data: Blob }[]) =>
    void run(t('crosspoint.tools.sleep.adding'), async (say) => {
      await reader.makeFolder('/', SLEEP_FOLDER.slice(1));
      const taken = new Set((data?.images ?? []).map((i) => i.path.slice(i.path.lastIndexOf('/') + 1).toLowerCase()));
      const problems: string[] = [];
      for (const [i, file] of files.entries()) {
        say(t('crosspoint.tools.sleep.addingOne', { name: file.name, n: i + 1, total: files.length }));
        try {
          const image = await makeSleepImage(file.data, profile, placement);
          const name = sleepImageName(file.name, taken);
          taken.add(name.toLowerCase());
          await reader.upload(`${SLEEP_FOLDER}/${name}`, image);
          fetched.set(`${SLEEP_FOLDER}/${name}:${image.size}`, URL.createObjectURL(image));
        } catch (e) {
          problems.push(t('crosspoint.tools.sleep.problem', { name: file.name, message: e instanceof Error ? e.message : String(e) }));
        }
      }
      if (problems.length) throw new Error(problems.join(' '));
    });

  const remove = (image: SleepImage) => void run(t('crosspoint.tools.sleep.removing'), () => reader.remove(image.path));

  const mode = data?.setting;
  const custom = mode && (mode.value === SLEEP_CUSTOM || mode.value === SLEEP_COVER_CUSTOM);
  const single = data?.images.some((i) => i.where === 'single');
  const own = data?.images.some((i) => !i.where);
  const screen = SCREEN[profile];

  return (
    <>
      <Note>
        {t('crosspoint.tools.sleep.note', { width: screen.width, height: screen.height })}
      </Note>
      {mode && !custom && (
        <Note>
          {t('crosspoint.tools.sleep.modeNote', { mode: mode.options?.[Number(mode.value)] ?? mode.value })}{' '}
          <Button $variant="secondary" $size="small" disabled={!!busy} onClick={() => void run(t('crosspoint.tools.sleep.changing'), () => reader.changeSettings({ sleepScreen: SLEEP_CUSTOM }))}>
            {t('crosspoint.tools.sleep.showThese')}
          </Button>
        </Note>
      )}
      {single && <Note>{t('crosspoint.tools.sleep.single')}</Note>}
      {own && data?.images.some((i) => i.where === 'fallback') && (
        <Note>{t('crosspoint.tools.sleep.fallback')}</Note>
      )}
      <Actions>
        <PickButton accept="image/*" disabled={!!busy} onPick={add}>
          {t('crosspoint.tools.sleep.addPictures')}
        </PickButton>
        <label>
          <SmallSelect value={placement} aria-label={t('crosspoint.tools.sleep.placement')} onChange={(e) => setPlacement(e.target.value as Placement)}>
            <option value="fill">{t('crosspoint.tools.sleep.fill')}</option>
            <option value="fit">{t('crosspoint.tools.sleep.fit')}</option>
          </SmallSelect>
        </label>
      </Actions>
      <Status busy={busy} error={error} />
      {!data && !error && <Note>{t('crosspoint.tools.readingReader')}</Note>}
      {data && data.images.length === 0 && <Note>{t('crosspoint.tools.sleep.none')}</Note>}
      {data && data.images.length > 0 && (
        <Grid>
          {data.images.map((image) => (
            <li key={image.path}>
              <Thumbnail reader={reader} image={image} ratio={`${screen.width} / ${screen.height}`} />
              <small title={image.path}>
                {image.where === 'single' ? t('crosspoint.tools.sleep.always') : image.path.slice(image.path.lastIndexOf('/') + 1)}
              </small>
              <Button $variant="secondary" $size="small" disabled={!!busy} onClick={() => remove(image)}>
                {t('crosspoint.tools.remove')}
              </Button>
            </li>
          ))}
        </Grid>
      )}
    </>
  );
}

/** Pictures load one after another: the reader serves one request at a time, slowly. */
let queue: Promise<unknown> = Promise.resolve();

function Thumbnail({ reader, image, ratio }: ToolProps & { image: SleepImage; ratio: string }) {
  const key = `${image.path}:${image.size}`;
  const [url, setUrl] = useState(fetched.get(key));
  useEffect(() => {
    if (url) return;
    let cancelled = false;
    queue = queue.then(async () => {
      if (cancelled) return;
      try {
        const blob = await reader.download(image.path);
        const made = URL.createObjectURL(blob);
        fetched.set(key, made);
        if (!cancelled) setUrl(made);
      } catch {
        // Left blank; the name still shows.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reader, image.path, key, url]);
  return <Picture $ratio={ratio}>{url && <img src={url} alt="" />}</Picture>;
}
