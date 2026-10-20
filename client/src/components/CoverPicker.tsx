import type { Item } from '@nexlibris/common';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { coverFromFile, type NewCover } from '../library/editCover';
import { generateCover } from '../library/generateCover';
import { fetchCover, findCovers, type CoverChoice } from '../isbn/openLibrary';
import { Muted } from '../styles/ui';
import { Cover } from './Cover';
import { EditIcon } from './icons';
import { MenuEntry, MenuPanel } from './MenuButton';

const Frame = styled.div`
  position: relative;
`;

const Preview = styled.img`
  display: block;
  width: 100%;
  aspect-ratio: 2 / 3;
  object-fit: cover;
  border-radius: 4px;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.15);
`;

/** The edit button over the cover's corner, legible on any cover. */
const EditButton = styled.button.attrs({ type: 'button' })`
  position: absolute;
  right: 6px;
  bottom: 6px;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid rgb(255 255 255 / 0.35);
  border-radius: 50%;
  background: rgb(0 0 0 / 0.6);
  color: #fff;
  cursor: pointer;

  &:hover,
  &[aria-expanded='true'] {
    background: rgb(0 0 0 / 0.8);
  }

  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
`;

const Panel = styled(MenuPanel)`
  width: min(300px, calc(100vw - 8px));

  > p {
    margin: 4px 10px;
    font-size: 0.85em;
  }
`;

const Choices = styled.ul`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(60px, 1fr));
  gap: 6px;
  max-height: 260px;
  overflow-y: auto;
  margin: 4px 0 0;
  padding: 4px;
  border-top: 1px solid var(--border);
  list-style: none;
`;

const Choice = styled.button.attrs({ type: 'button' })<{ $busy: boolean }>`
  display: block;
  width: 100%;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 6px;
  background: var(--hover);
  cursor: pointer;
  opacity: ${(p) => (p.$busy ? 0.5 : 1)};

  &:hover,
  &:focus-visible {
    border-color: var(--accent);
    outline: none;
  }

  img {
    display: block;
    width: 100%;
    aspect-ratio: 2 / 3;
    object-fit: cover;
    border-radius: 4px;
  }
`;

/** A blob shown as an image, by a URL that lasts as long as the element does. */
function BlobImage({ blob, alt }: { blob: Blob; alt: string }) {
  const show = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image) return;
      const url = URL.createObjectURL(blob);
      image.src = url;
      return () => URL.revokeObjectURL(url);
    },
    [blob],
  );
  return <Preview ref={show} alt={alt} />;
}

interface Props {
  item: Item;
  /** The cover chosen and not yet saved, if any. */
  cover: NewCover | undefined;
  onChange(cover: NewCover | undefined): void;
  /** Open Library's fetch, replaced in stories. */
  fetchFn?: typeof fetch;
}

/**
 * The editor's cover: the cover as it will be saved, with an edit button over it opening a
 * dropdown to choose an image file, pick one of Open Library's covers for the book (by its ISBNs,
 * then title and author; looked up only when asked) or generate one (another colour each time).
 */
export function CoverPicker({ item, cover, onChange, fetchFn }: Props) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number }>();
  const [choices, setChoices] = useState<CoverChoice[]>();
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    setPlace(undefined);
    if (refocus) button.current?.focus();
  };

  // Below the cover's button, starting at the cover's left edge, kept on screen; above it if there's no room below.
  useLayoutEffect(() => {
    if (!open || !button.current || !panel.current) return;
    const anchor = button.current.getBoundingClientRect();
    const frame = button.current.parentElement!.getBoundingClientRect();
    const { offsetHeight: height, offsetWidth: width } = panel.current;
    const below = anchor.bottom + 4;
    const top = below + height > window.innerHeight && anchor.top - 4 - height > 0 ? anchor.top - 4 - height : below;
    setPlace({ top, left: Math.max(4, Math.min(frame.left, window.innerWidth - width - 4)) });
  }, [open, choices, status]);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) close(false);
    };
    const away = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [open]);

  const choose = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const picked = coverFromFile(file);
    if (picked) {
      onChange(picked);
      close(true);
    } else {
      setStatus(`${file.name} isn’t an image.`);
    }
  };

  const find = async () => {
    setBusy('search');
    setStatus(undefined);
    try {
      const found = await findCovers(
        {
          isbns: Object.entries(item.identifiers).filter(([scheme]) => /^isbn/i.test(scheme)).map(([, value]) => value),
          title: item.title,
          authors: item.creators.filter((c) => c.role === 'aut').map((c) => c.name),
        },
        fetchFn,
      );
      setChoices(found);
      if (!found.length) setStatus('Open Library has no covers for this book.');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  // Stays open, so generating again tries another colour.
  const generate = async () => {
    setBusy('generate');
    setStatus(undefined);
    try {
      onChange(await generateCover(item));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const take = async (choice: CoverChoice) => {
    setBusy(choice.url);
    setStatus(undefined);
    try {
      const fetched = await fetchCover(choice.url, fetchFn);
      if (fetched) {
        onChange(fetched);
        close(true);
      } else {
        setStatus('Couldn’t download that cover.');
      }
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Frame>
      {cover ? <BlobImage blob={cover.data} alt="New cover" /> : <Cover item={item} />}
      <EditButton
        ref={button}
        aria-label="Change cover"
        title="Change cover"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <EditIcon />
      </EditButton>
      <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => choose(e.target.files)} />
      {open && (
        <Panel
          ref={panel}
          role="dialog"
          aria-label="Change cover"
          style={place ? { top: place.top, left: place.left } : { visibility: 'hidden' }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            close(true);
          }}
        >
          <MenuEntry onClick={() => fileInput.current?.click()}>Choose image…</MenuEntry>
          <MenuEntry disabled={!!busy} onClick={() => void find()}>
            {busy === 'search' ? 'Searching Open Library…' : 'Find on Open Library'}
          </MenuEntry>
          <MenuEntry disabled={!!busy} onClick={() => void generate()}>
            {busy === 'generate' ? 'Generating…' : 'Generate'}
          </MenuEntry>
          {cover && (
            <MenuEntry
              onClick={() => {
                onChange(undefined);
                close(true);
              }}
            >
              Undo change
            </MenuEntry>
          )}
          {status && (
            <Muted as="p" role="status">
              {status}
            </Muted>
          )}
          {choices && choices.length > 0 && (
            <Choices aria-label="Covers from Open Library">
              {choices.map((choice) => (
                <li key={choice.url}>
                  <Choice
                    $busy={busy === choice.url}
                    disabled={!!busy}
                    title={choice.label}
                    aria-label={`Use the cover of ${choice.label}`}
                    onClick={() => void take(choice)}
                  >
                    <img src={choice.preview} alt="" loading="lazy" />
                  </Choice>
                </li>
              ))}
            </Choices>
          )}
        </Panel>
      )}
    </Frame>
  );
}
