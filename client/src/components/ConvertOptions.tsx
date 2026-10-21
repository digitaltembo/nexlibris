import { useState, type ReactNode } from 'react';
import styled from 'styled-components';
import type { SettingField } from '../devices/types';
import type { Converter } from '@nexlibris/tools/formats/convert/converters';
import { Muted, SmallSelect } from '../styles/ui';
import { formatLabel } from './ItemFiles';

/** A labelled field: its label over its input, help below. */
export const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 12px;

  small {
    color: var(--muted);
  }
`;

/** A yes-or-no option: its box before its label. */
const CheckField = styled(Field)`
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 8px;
  align-items: center;

  small {
    grid-column: 2;
  }
`;

/** Each field at its default, by key. */
export const optionDefaults = (fields: SettingField[]) => Object.fromEntries(fields.map((f) => [f.key, f.default]));

/**
 * The values of options that come and go with the conversion chosen: each at its default until it's
 * changed, and a change kept while its field is away. Set them to `{}` for the defaults again.
 */
export function useOptionValues(fields: SettingField[]) {
  const [changed, setChanged] = useState<Record<string, string>>({});
  return [{ ...optionDefaults(fields), ...changed }, setChanged] as const;
}

/** A path's formats in turn, e.g. "MOBI → EPUB → EPUB (X4)". */
export const pathLabel = (from: string, path: Converter[]) => [from, ...path.map((c) => c.to)].map(formatLabel).join(' → ');

/** Said of a conversion made by way of other formats, each step of which can lose something. */
export function IndirectNote({ children }: { children: ReactNode }) {
  return (
    <Note role="note">
      {children} Each step can lose some formatting, so a direct conversion is better where there is one.
    </Note>
  );
}

const Note = styled(Muted).attrs({ as: 'p' })`
  margin: 12px 0 0;
  padding: 8px 10px;
  border-left: 3px solid var(--accent);
  font-size: 0.9em;
`;

interface Props {
  fields: SettingField[];
  values: Record<string, string>;
  onChange(values: Record<string, string>): void;
  disabled?: boolean;
}

/** A converter's options, as asked for when converting. */
export function ConvertOptions({ fields, values, onChange, disabled }: Props) {
  return fields.map((field) =>
    field.kind === 'checkbox' ? (
      <CheckField key={field.key}>
        <input
          type="checkbox"
          checked={(values[field.key] || field.default) === 'yes'}
          disabled={disabled}
          onChange={(e) => onChange({ ...values, [field.key]: e.target.checked ? 'yes' : 'no' })}
        />
        {field.label}
        {field.help && <small>{field.help}</small>}
      </CheckField>
    ) : (
      <Field key={field.key}>
        {field.label}
        {field.choices ? (
          <SmallSelect
            value={values[field.key] || field.default}
            disabled={disabled}
            onChange={(e) => onChange({ ...values, [field.key]: e.target.value })}
          >
            {field.choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </SmallSelect>
        ) : (
          <input
            value={values[field.key] ?? ''}
            placeholder={field.default}
            disabled={disabled}
            {...(field.range && { type: 'number', min: field.range.min, max: field.range.max, step: 1 })}
            onChange={(e) => onChange({ ...values, [field.key]: e.target.value })}
          />
        )}
        {field.help && <small>{field.help}</small>}
      </Field>
    ),
  );
}
