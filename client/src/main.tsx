import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { LibraryProvider } from './library/LibraryContext';
import { GlobalStyle } from './styles/GlobalStyle';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GlobalStyle />
    <LibraryProvider>
      <App />
    </LibraryProvider>
  </StrictMode>,
);
