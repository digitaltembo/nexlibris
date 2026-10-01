import { act, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useBackToClose } from './useBackToClose';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let setPanel: (open: boolean) => void;
let setReader: (open: boolean) => void;
let state = { panel: false, reader: false };

function Harness() {
  const [panel, setPanelState] = useState(false);
  const [reader, setReaderState] = useState(false);
  setPanel = setPanelState;
  setReader = setReaderState;
  state = { panel, reader };
  useBackToClose(panel, () => setPanelState(false));
  useBackToClose(reader, () => setReaderState(false));
  return null;
}

/** Lets deferred history updates and popstate events run. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

async function back() {
  await act(async () => history.back());
  await settle();
}

let root: ReturnType<typeof createRoot> | undefined;

async function mount() {
  root = createRoot(document.createElement('div'));
  await act(async () =>
    root!.render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    ),
  );
}

afterEach(async () => {
  await act(async () => root?.unmount());
  await settle();
});

describe('useBackToClose', () => {
  it('closes the most recently opened overlay first, one per Back', async () => {
    await mount();
    const start = history.length;
    await act(async () => setPanel(true));
    await settle();
    await act(async () => setReader(true));
    await settle();
    // One history entry per open overlay.
    expect(history.length).toBe(start + 2);

    await back();
    expect(state).toEqual({ panel: true, reader: false });
    await back();
    expect(state).toEqual({ panel: false, reader: false });
  });

  it('closing the last overlay without Back removes its history entry', async () => {
    await mount();
    await act(async () => setPanel(true));
    await settle();
    expect(history.state).toEqual({ nexlibrisOverlays: 1 });

    await act(async () => setPanel(false));
    await settle();
    expect(history.state).toBeNull();
  });

  it('after closing the inner overlay without Back, Back closes the outer one', async () => {
    await mount();
    await act(async () => setPanel(true));
    await settle();
    await act(async () => setReader(true));
    await settle();
    await act(async () => setReader(false));
    await settle();
    expect(history.state).toEqual({ nexlibrisOverlays: 1 });

    await back();
    expect(state).toEqual({ panel: false, reader: false });
    expect(history.state).toBeNull();
  });
});
