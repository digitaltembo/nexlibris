import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { TextIndexProvider } from './fulltext/TextIndexContext';
import { LibraryProvider } from './library/LibraryContext';
import { GlobalStyle } from './styles/GlobalStyle';

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
