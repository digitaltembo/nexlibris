import styled, { css } from 'styled-components';
import { NARROW } from './GlobalStyle';

export interface ButtonProps {
  $variant?: 'primary' | 'secondary' | 'danger' | 'icon';
  $size?: 'small';
}

const variants = {
  primary: css`
    background: var(--accent);
    color: var(--accent-text);
  `,
  secondary: css`
    background: var(--surface);
    color: var(--text);
    border-color: var(--border);

    &:hover:not(:disabled) {
      background: var(--hover);
      border-color: var(--soft-border);
    }
  `,
  danger: css`
    background: var(--danger);
    color: var(--surface);
  `,
  icon: css`
    background: none;
    color: var(--muted);
    padding: 2px 8px;
    font-size: 1.2em;

    &:hover:not(:disabled) {
      color: var(--text);
    }
  `,
};

export const buttonStyles = css<ButtonProps>`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 6px 12px;
  cursor: pointer;
  white-space: nowrap;
  ${(p) => variants[p.$variant ?? 'primary']}
  ${(p) =>
    p.$size === 'small' &&
    css`
      padding: 2px 8px;
      font-size: 0.85em;
    `}

  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
`;

export const Button = styled.button.attrs<ButtonProps>((p) => ({ type: p.type ?? 'button' }))<ButtonProps>`
  ${buttonStyles}
`;

/** A label styled as a button, wrapping a hidden file input. */
export const FileButton = styled.label<ButtonProps>`
  ${buttonStyles}

  &:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
`;

export const SmallSelect = styled.select`
  padding: 2px 6px;
  font-size: 0.85em;
`;

export const Muted = styled.span`
  color: var(--muted);
`;

export const Status = styled.p<{ $error?: boolean }>`
  padding: 2rem;
  text-align: center;
  ${(p) => p.$error && 'color: var(--danger);'}
`;

export const Badge = styled.span`
  white-space: nowrap;
  font-size: 0.75em;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);

  & + & {
    margin-left: 4px;
  }
`;

export const Spacer = styled.span`
  flex: 1;
`;

/** A horizontal row of controls; inputs share the spare width. */
export const Row = styled.div`
  display: flex;
  gap: 6px;
  align-items: center;

  > input {
    flex: 1;
  }
`;

/** A vertical list of rows, such as editable key/value pairs or files. */
export const Stack = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
`;

/* Tags */

export const TagList = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
`;

const chip = css`
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: var(--soft);
  border: 1px solid var(--soft-border);
`;

/** A chip holding a label and a remove button. */
export const Tag = styled.span`
  ${chip}
`;

/** A whole chip that's one button, e.g. a tag to search for. */
export const TagButton = styled.button.attrs({ type: 'button' })`
  ${chip}
  padding: 2px 10px;
  color: var(--text);

  &:hover {
    border-color: var(--accent);
  }
`;

export const TagLabel = styled.span`
  padding: 2px 4px 2px 10px;
`;

export const TagRemove = styled.button.attrs({ type: 'button' })`
  background: none;
  border: none;
  padding: 2px 8px 2px 2px;
  color: var(--muted);

  &:hover {
    color: var(--text);
  }
`;

/* The right-hand panel */

export const Panel = styled.aside`
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: var(--detail-width);
  overflow-y: auto;
  padding: 16px;
  background: var(--surface);
  border-left: 1px solid var(--border);
  z-index: 2;

  ${NARROW} {
    width: 100%;
    border-left: none;
  }
`;

export const PanelSection = styled.section`
  margin-top: 20px;
`;

export const SectionHeading = styled.h3`
  margin: 0 0 6px;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
`;

export const PanelFooter = styled.footer<{ $sticky?: boolean }>`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 28px;
  padding-top: 16px;
  border-top: 1px solid var(--border);

  ${(p) =>
    p.$sticky &&
    css`
      position: sticky;
      bottom: -16px;
      margin-bottom: -16px;
      padding-bottom: 16px;
      background: var(--surface);
    `}
`;

/** Leaves room for the panel beside the library, except on narrow screens where it covers it. */
export const besidePanel = css<{ $withPanel: boolean }>`
  ${(p) =>
    p.$withPanel &&
    css`
      margin-right: var(--detail-width);

      ${NARROW} {
        margin-right: 0;
      }
    `}
`;
