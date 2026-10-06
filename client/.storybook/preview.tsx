import type { Preview } from '@storybook/react-vite';
import { useLayoutEffect } from 'react';
import { TextIndexProvider } from '../src/fulltext/TextIndexContext';
import { LibraryProvider } from '../src/library/LibraryContext';
import { openSampleLibrary } from '../src/stories/sampleLibrary';
import { applyAppearance, APPEARANCES, type Appearance } from '../src/styles/appearance';
import { GlobalStyle } from '../src/styles/GlobalStyle';

/**
 * Every story gets the app's theme (which follows the OS's light or dark setting, or the toolbar's
 * Theme, as the app follows a pick in Settings) and a library:
 * a fresh in-memory copy of the sample library, so components that read or edit it work and
 * nothing is stored.
 */
function Themed({ appearance }: { appearance: Appearance }) {
  useLayoutEffect(() => applyAppearance(appearance), [appearance]);
  return null;
}

const preview: Preview = {
  globalTypes: {
    appearance: {
      description: 'Light or dark, as picked in Settings',
      toolbar: { title: 'Theme', icon: 'mirror', items: APPEARANCES.map((a) => ({ value: a.id, title: a.label })), dynamicTitle: true },
    },
  },
  initialGlobals: { appearance: 'system' },
  decorators: [
    (Story, { globals }) => (
      <>
        <Themed appearance={(globals.appearance as Appearance | undefined) ?? 'system'} />
        <GlobalStyle />
        <LibraryProvider open={openSampleLibrary}>
          <TextIndexProvider>
            <Story />
          </TextIndexProvider>
        </LibraryProvider>
      </>
    ),
  ],
  parameters: {
    layout: 'padded',
    controls: { matchers: { color: /(background|color)$/i } },
  },
};

export default preview;
