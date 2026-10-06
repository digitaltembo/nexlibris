import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { TextIndexProvider } from './fulltext/TextIndexContext';
import { LibraryProvider } from './library/LibraryContext';
import { applyAppearance, storedAppearance } from './styles/appearance';
import { GlobalStyle } from './styles/GlobalStyle';

// Before the first render, so a picked light or dark doesn't flash the system's.
applyAppearance(storedAppearance());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GlobalStyle />
    <LibraryProvider>
      <TextIndexProvider>
        <App />
      </TextIndexProvider>
    </LibraryProvider>
  </StrictMode>,
);
