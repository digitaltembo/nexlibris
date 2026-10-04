import type { Preview } from '@storybook/react-vite';
import { TextIndexProvider } from '../src/fulltext/TextIndexContext';
import { LibraryProvider } from '../src/library/LibraryContext';
import { openSampleLibrary } from '../src/stories/sampleLibrary';
import { GlobalStyle } from '../src/styles/GlobalStyle';

/**
 * Every story gets the app's theme (which follows the OS's light or dark setting) and a library:
 * a fresh in-memory copy of the sample library, so components that read or edit it work and
 * nothing is stored.
 */
const preview: Preview = {
  decorators: [
    (Story) => (
      <>
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
