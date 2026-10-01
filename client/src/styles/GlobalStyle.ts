import { createGlobalStyle } from 'styled-components';

/**
 * Theme tokens and element defaults. Colors are CSS variables rather than a
 * ThemeProvider theme so dark mode follows the OS setting without any JS.
 *
 * The palette: regal navy #0d3b66, lemon chiffon #faf0ca, royal gold #f4d35e,
 * sandy brown #ee964b and tomato #f95738. Light mode is chiffon paper with navy
 * ink; dark mode is navy with chiffon text and gold accents. Where a palette
 * color is too pale to read on the background, a darker shade of it stands in.
 * Sandy brown marks what's pressed, hovered or picked out (--highlight, --hover,
 * --soft), rather than a second shade of the background.
 */
export const GlobalStyle = createGlobalStyle`
  :root {
    --bg: #fdf8e5;
    --surface: #fffdf5;
    --highlight: #ee964b;
    --highlight-text: #0d3b66;
    --hover: #fdecd9;
    --soft: #fbe0c4;
    --soft-border: #f2b47e;
    --text: #0a2540;
    --muted: #55687c;
    --border: #e6d9a8;
    --accent: #0d3b66;
    --accent-text: #faf0ca;
    --danger: #c43c20;
    --star: #cf6f1f;
    --radius: 8px;
    --detail-width: 420px;
    color-scheme: light;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 15px;
    line-height: 1.4;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #071f37;
      --surface: #0a2b4c;
      --highlight: #ee964b;
      --highlight-text: #0d3b66;
      /* Sandy brown mixed into navy turns grey, so soft areas are a lighter navy, edged in sandy brown. */
      --hover: #0f3a63;
      --soft: #154878;
      --soft-border: #ee964b;
      --text: #faf0ca;
      --muted: #a9b3a9;
      --border: #1c4c7a;
      --accent: #f4d35e;
      --accent-text: #0d3b66;
      --danger: #ff6847;
      --star: #f4d35e;
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
