import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ReaderWindow } from './components/ReaderWindow';
import { TextIndexProvider } from './fulltext/TextIndexContext';
import { LibraryProvider } from './library/LibraryContext';
import { readerAddress } from './library/readerWindow';
import { applyAppearance, storedAppearance } from './styles/appearance';
import { GlobalStyle } from './styles/GlobalStyle';

// Before the first render, so a picked light or dark doesn't flash the system's.
applyAppearance(storedAppearance());

const reading = readerAddress();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GlobalStyle />
    {reading ? (
      // A book's own window: the reader alone, with the book from the library's window.
      <ReaderWindow {...reading} />
    ) : (
      <LibraryProvider>
        <TextIndexProvider>
          <App />
        </TextIndexProvider>
      </LibraryProvider>
    )}
  </StrictMode>,
);
