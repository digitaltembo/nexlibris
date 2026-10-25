import { useMemo, useState, type ReactNode } from 'react';
import styled from 'styled-components';
import { DEFAULT_DESC, type Sort, type SortKey } from '@nexlibris/common';
import { fieldLabel } from '../library/fieldLabels';
import { BUILTIN_COLUMNS, DEFAULT_COLUMNS, fieldColumn, type ColumnId } from '../library/columns';
import type { PairHow } from './InstanceSync';
import { Button, Muted, Spacer } from '../styles/ui';
import { InlineModal, Modal, ModalFooter } from './Modal';
import { APPEARANCES, type Appearance } from '../styles/appearance';
import { VIEWS, type View } from '../views/views';
import { AccountDialog } from './AccountDialog';
import { BackupDialog } from './BackupDialog';
import { CategoriesDialog } from './CategoriesDialog';
import { ConnectionsDialog } from './ConnectionsDialog';
import { LibraryFolderDialog } from './LibraryFolderDialog';
import { t } from '../i18n';

export type { View } from '../views/views';

export const SORT_LABELS: Record<SortKey, string> = {
  title: t('settings.sort.title'),
  author: t('settings.sort.author'),
  series: t('settings.sort.series'),
  published: t('settings.sort.published'),
  rating: t('settings.sort.rating'),
  size: t('settings.sort.size'),
  added: t('settings.sort.added'),
};

const Group = styled.fieldset`
  margin: 16px 0 0;
  padding: 0;
  border: none;

  legend {
    margin-bottom: 6px;
    padding: 0;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
`;

const Options = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 4px 16px;

  label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
    overflow-wrap: anywhere;
    cursor: pointer;
  }
`;

const Segmented = styled.div`
  display: inline-flex;

  > button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 0;
    background: var(--surface);
    color: var(--text);
  }

  > button:first-child {
    border-radius: var(--radius) 0 0 var(--radius);
  }

  > button + button {
    border-left: none;
  }

  > button:last-child {
    border-radius: 0 var(--radius) var(--radius) 0;
  }

  > button[aria-pressed='true'] {
    background: var(--highlight);
    color: var(--highlight-text);
    border-color: var(--highlight);
    font-weight: 600;
  }
`;

const SortRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
`;

const Layout = styled.div`
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 170px 1fr;
  gap: 20px;
  margin-top: 16px;

  @media (max-width: 640px) {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
    gap: 12px;
  }
`;

const TabList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;

  button {
    padding: 7px 10px;
    border: none;
    border-radius: var(--radius);
    background: none;
    color: var(--muted);
    font: inherit;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  button:hover {
    color: var(--text);
  }

  button[aria-selected='true'] {
    background: var(--highlight);
    color: var(--highlight-text);
    font-weight: 600;
  }

  @media (max-width: 640px) {
    flex-direction: row;
    overflow-x: auto;
  }
`;

const TabPanel = styled.div`
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
`;

const Heading = styled.h3`
  margin: 0;
  font-size: 1.1rem;
`;

const TABS = ['appearance', 'folder', 'backup', 'account', 'categories', 'connections'] as const;
export type SettingsTab = (typeof TABS)[number];

interface Props {
  /** The tab asked for, at opening or by a menu since: each new request shows its tab. */
  asked: { tab: SettingsTab };
  /** Whether there's an account to show (a page from a server, or the apps). */
  accounts: boolean;
  view: View;
  onView(view: View): void;
  /** Light or dark, or as the system is. */
  appearance: Appearance;
  onAppearance(appearance: Appearance): void;
  sort: Sort;
  onSort(sort: Sort): void;
  /** The list view's columns. */
  columns: string[];
  /** Metadata fields that can be shown as columns. */
  fields: string[];
  onColumns(columns: string[]): void;
  onClose(): void;
}

/**
 * The settings, a tab each: how the library is shown, its folder, backup, the account, categories and connections. The
 * other tabs are their dialogs shown in place (`InlineModal`); a tab once opened stays mounted, hidden, so a backup or
 * move carries on while another is shown.
 */
export function SettingsDialog({ asked, accounts, onClose, view, onView, appearance, onAppearance, sort, onSort, columns, fields, onColumns }: Props) {
  // The tab is kept here rather than by the app, so switching renders only this, not the library behind it.
  const [tab, onTab] = useState(asked.tab);
  const [lastAsked, setLastAsked] = useState(asked);
  if (asked !== lastAsked) {
    setLastAsked(asked);
    onTab(asked.tab);
  }
  const [pair, setPair] = useState<PairHow>();
  const [visited, setVisited] = useState<ReadonlySet<SettingsTab>>(() => new Set([tab]));
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]));
  /** Each tab's dialog's onClose, which Escape calls while it's shown (one that's busy may refuse). */
  const [closers] = useState(() => new Map<SettingsTab, () => void>());
  // Stable, so the tabs' dialogs aren't rendered again on switching.
  const [register] = useState(
    () => Object.fromEntries(TABS.map((id) => [id, (close: () => void) => void closers.set(id, close)])) as Record<SettingsTab, (close: () => void) => void>,
  );

  // The panels, made again only when what they show changes: switching tabs only hides one and shows another, rather
  // than rendering every tab opened (some search the whole library).
  const tabs = useMemo((): { id: SettingsTab; label: string; panel: ReactNode }[] => [
    {
      id: 'appearance',
      label: t('settings.tabs.appearance'),
      panel: (
        <AppearanceSettings
          {...{ view, onView, appearance, onAppearance, sort, onSort, columns, fields, onColumns, onClose }}
        />
      ),
    },
    {
      id: 'folder',
      label: t('settings.tabs.folder'),
      panel: (
        <LibraryFolderDialog
          onClose={onClose}
          onAccount={() => onTab('account')}
          onSyncWithAccount={() => {
            setPair('server');
            onTab('connections');
          }}
        />
      ),
    },
    { id: 'backup', label: t('settings.tabs.backup'), panel: <BackupDialog onClose={onClose} /> },
    ...(accounts
      ? [{ id: 'account' as const, label: t('settings.tabs.account'), panel: <AccountDialog onClose={onClose} onLibraryFolder={() => onTab('folder')} /> }]
      : []),
    { id: 'categories', label: t('settings.tabs.categories'), panel: <CategoriesDialog onClose={onClose} /> },
    // Keyed by how it pairs, so asking to pair again opens on it.
    { id: 'connections', label: t('settings.tabs.connections'), panel: <ConnectionsDialog key={pair} onClose={onClose} {...(pair && { pair })} /> },
  ], [accounts, pair, onClose, view, onView, appearance, onAppearance, sort, onSort, columns, fields, onColumns]);

  return (
    <Modal title={t('settings.title')} wide onClose={() => (closers.get(tab) ?? onClose)()}>
      <Layout>
        <TabList role="tablist" aria-orientation="vertical" aria-label={t('settings.title')}>
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`settings-tab-${entry.id}`}
              aria-controls={`settings-panel-${entry.id}`}
              aria-selected={tab === entry.id}
              onClick={() => onTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </TabList>
        {tabs
          .filter((t) => visited.has(t.id))
          .map((t) => (
            <TabPanel
              key={t.id}
              role="tabpanel"
              id={`settings-panel-${t.id}`}
              aria-labelledby={`settings-tab-${t.id}`}
              hidden={tab !== t.id}
            >
              <InlineModal.Provider value={register[t.id]}>{t.panel}</InlineModal.Provider>
            </TabPanel>
          ))}
      </Layout>
    </Modal>
  );
}

type AppearanceProps = Omit<Props, 'asked' | 'accounts'>;

/**
 * How the library is shown: light or dark, the view, and the sort (grid and bookshelf) or the columns (list), as the
 * view has them. Changes apply as they're made.
 */
function AppearanceSettings({ view, onView, appearance, onAppearance, sort, onSort, columns, fields, onColumns, onClose }: AppearanceProps) {
  // The list sorts by its column headers, and the graph has no order.
  const sorted = view === 'grid' || view === 'bookshelf.shelf';
  const toggle = (id: ColumnId, on: boolean) => onColumns(on ? [...columns, id] : columns.filter((s) => s !== id));
  const checkbox = (id: ColumnId, text: string) => (
    <label key={id}>
      <input type="checkbox" checked={columns.includes(id)} onChange={(e) => toggle(id, e.target.checked)} />
      {text}
    </label>
  );

  return (
    <section>
      <Heading>{t('settings.appearance')}</Heading>
      <Group>
        <legend>{t('settings.theme')}</legend>
        <Segmented role="group" aria-label={t('settings.appearance')}>
          {APPEARANCES.map((a) => (
            <button key={a.id} type="button" aria-pressed={appearance === a.id} onClick={() => onAppearance(a.id)}>
              {a.label}
            </button>
          ))}
        </Segmented>
      </Group>
      <Group>
        <legend>{t('settings.view')}</legend>
        <Segmented role="group" aria-label={t('settings.view')}>
          {VIEWS.map((v) => (
            <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => onView(v.id)}>
              {v.icon}
              {v.label}
            </button>
          ))}
        </Segmented>
      </Group>
      {sorted && (
        <Group>
          <legend>{t('settings.sortHeading')}</legend>
          <SortRow>
            <select
              value={sort.key}
              aria-label={t('settings.sortBy')}
              onChange={(e) => {
                const key = e.target.value as SortKey;
                onSort({ key, desc: DEFAULT_DESC[key] });
              }}
            >
              {Object.entries(SORT_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <label>
              <input type="checkbox" checked={sort.desc} onChange={(e) => onSort({ ...sort, desc: e.target.checked })} /> {t('settings.descending')}
            </label>
          </SortRow>
        </Group>
      )}
      {view === 'list' && (
        <Group>
          <legend>{t('settings.listColumns')}</legend>
          <Muted as="p">{t('settings.titleAlways')}</Muted>
          <Options>{BUILTIN_COLUMNS.map((c) => checkbox(c.id, c.label))}</Options>
          {fields.length > 0 && (
            <>
              <Muted as="p">{t('settings.fields')}</Muted>
              <Options>{fields.map((key) => checkbox(fieldColumn(key), fieldLabel(key)))}</Options>
            </>
          )}
        </Group>
      )}
      <ModalFooter>
        {view === 'list' && (
          <Button $variant="secondary" onClick={() => onColumns(DEFAULT_COLUMNS)}>
            {t('settings.resetColumns')}
          </Button>
        )}
        <Spacer />
        <Button onClick={onClose}>{t('common.done')}</Button>
      </ModalFooter>
    </section>
  );
}
