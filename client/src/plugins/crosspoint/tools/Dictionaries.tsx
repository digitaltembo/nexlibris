import { useState } from 'react';
import { Button } from '../../../styles/ui';
import { DICTIONARY_ROOT, HIDDEN_DICTIONARY_ROOT, isSidecar, parseIfo, prepareDictionaries } from '@nexlibris/crosspoint-tools/stardict';
import { Actions, Note, PickButton, Rows, sizeLabel, Status, useReaderState, type ToolProps } from './shared';
import { t } from '../../../i18n';

interface InstalledDictionary {
  name: string;
  folder: string;
  title?: string;
  words?: number;
  size: number;
  files: string[];
}

const ACCEPT = '.zip,.tar,.gz,.tgz,.idx,.dict,.dz,.syn,.ifo';

/** The reader's StarDict dictionaries, for looking words up while reading: listed, added and removed. */
export function Dictionaries({ reader }: ToolProps) {
  const [problems, setProblems] = useState<string[]>([]);
  const { data, error, busy, run } = useReaderState<InstalledDictionary[]>(async () => {
    const found: InstalledDictionary[] = [];
    for (const root of [DICTIONARY_ROOT, HIDDEN_DICTIONARY_ROOT]) {
      for (const entry of await reader.entries(root)) {
        if (!entry.isDirectory || entry.name.startsWith('.')) continue;
        const folder = `${root}/${entry.name}`;
        const files = (await reader.entries(folder)).filter((e) => !e.isDirectory);
        if (!files.some((f) => /\.idx$/i.test(f.name))) continue;
        const ifo = files.find((f) => /\.ifo$/i.test(f.name));
        const fields = ifo ? parseIfo(await (await reader.download(`${folder}/${ifo.name}`)).text()) : {};
        const words = Number(fields.wordcount);
        found.push({
          name: entry.name,
          folder,
          ...(fields.bookname && { title: fields.bookname }),
          ...(words > 0 && { words }),
          size: files.filter((f) => !isSidecar(f.name)).reduce((n, f) => n + f.size, 0),
          files: files.map((f) => f.name),
        });
      }
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  });

  const add = (picked: { path: string; data: Blob }[]) =>
    void run(t('crosspoint.tools.dictionaries.reading'), async (say) => {
      const { dictionaries, problems: found } = await prepareDictionaries(picked);
      setProblems(found);
      if (!dictionaries.length) return;
      await reader.makeFolder('/', DICTIONARY_ROOT.slice(1));
      for (const dictionary of dictionaries) {
        await reader.makeFolder(DICTIONARY_ROOT, dictionary.name);
        for (const [i, file] of dictionary.files.entries()) {
          say(t('crosspoint.tools.dictionaries.copying', { name: dictionary.name, file: file.name, n: i + 1, total: dictionary.files.length }));
          await reader.upload(`${DICTIONARY_ROOT}/${dictionary.name}/${file.name}`, file.data);
        }
      }
    });

  const remove = (dictionary: InstalledDictionary) =>
    void run(t('crosspoint.tools.dictionaries.removing', { name: dictionary.name }), async () => {
      for (const file of dictionary.files) await reader.remove(`${dictionary.folder}/${file}`);
      await reader.remove(dictionary.folder);
    });

  return (
    <>
      <Note>
        {t('crosspoint.tools.dictionaries.note')}
      </Note>
      <Actions>
        <PickButton accept={ACCEPT} disabled={!!busy} onPick={add}>
          {t('crosspoint.tools.dictionaries.addFiles')}
        </PickButton>
        <PickButton folder disabled={!!busy} onPick={add}>
          {t('crosspoint.tools.addFolder')}
        </PickButton>
      </Actions>
      <Status busy={busy} error={error} problems={problems} />
      {!data && !error && <Note>{t('crosspoint.tools.readingReader')}</Note>}
      {data && data.length === 0 && <Note>{t('crosspoint.tools.dictionaries.none')}</Note>}
      {data && data.length > 0 && (
        <Rows>
          {data.map((dictionary) => (
            <li key={dictionary.folder}>
              <div>
                <strong>{dictionary.name}</strong>
                <small>
                  {[
                    dictionary.title !== dictionary.name && dictionary.title,
                    dictionary.words && t('crosspoint.tools.dictionaries.words', { count: dictionary.words, n: dictionary.words.toLocaleString() }),
                    sizeLabel(dictionary.size),
                    dictionary.folder.startsWith(HIDDEN_DICTIONARY_ROOT) && t('crosspoint.tools.dictionaries.hidden'),
                  ]
                    .filter(Boolean)
                    .join(t('common.list'))}
                </small>
              </div>
              <Button $variant="secondary" $size="small" disabled={!!busy} onClick={() => remove(dictionary)}>
                {t('crosspoint.tools.remove')}
              </Button>
            </li>
          ))}
        </Rows>
      )}
    </>
  );
}
