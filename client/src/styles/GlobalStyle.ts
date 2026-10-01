import { createGlobalStyle } from 'styled-components';

/**
 * Theme tokens and element defaults. Colors are CSS variables rather than a
 * ThemeProvider theme so dark mode follows the OS setting without any JS.
 */
export const GlobalStyle = createGlobalStyle`
  :root {
    --bg: #faf8f5;
    --surface: #ffffff;
    --surface-2: #f1ede6;
    --text: #22201c;
    --muted: #6f6a61;
    --border: #e2ddd4;
    --accent: #8a4b2a;
    --accent-text: #ffffff;
    --danger: #b3261e;
    --star: #c98a12;
    --radius: 8px;
    --detail-width: 420px;
    color-scheme: light;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 15px;
    line-height: 1.4;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #181715;
      --surface: #211f1c;
      --surface-2: #2b2925;
      --text: #ece8e1;
      --muted: #a39d93;
      --border: #3a3732;
      --accent: #d9915f;
      --accent-text: #1a1209;
      --danger: #f2827a;
      --star: #e8b54a;
      color-scheme: dark;
    }
  }

  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
  }

  input,
  select,
  textarea,
  button {
    font: inherit;
    color: inherit;
  }

  button {
    cursor: pointer;
  }

  input,
  select,
  textarea {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 8px;
    min-width: 0;
  }

  textarea {
    width: 100%;
    resize: vertical;
  }

  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible,
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
`;

/** Rendered while something covers the whole window, so the page behind it doesn't scroll. */
export const LockScroll = createGlobalStyle`
  body {
    overflow: hidden;
  }
`;

/** Narrow screens: the detail panel covers the library instead of sitting beside it. */
export const NARROW = '@media (max-width: 760px)';
