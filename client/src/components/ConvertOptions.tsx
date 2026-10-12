import { useState } from 'react';
import styled from 'styled-components';
import type { SettingField } from '../devices/types';
import type { Converter } from '../formats/convert/converters';
import { Button, SmallSelect, Spacer } from '../styles/ui';
import { Modal, ModalFooter } from './Modal';

const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 12px;

  small {
    color: var(--muted);
  }
`;

/** Each field at its default, by key. */
export const optionDefaults = (fields: SettingField[]) => Object.fromEntries(fields.map((f) => [f.key, f.default]));

interface Props {
  fields: SettingField[];
  values: Record<string, string>;
  onChange(values: Record<string, string>): void;
  disabled?: boolean;
}

/** A converter's options, as asked for when converting. */
export function ConvertOptions({ fields, values, onChange, disabled }: Props) {
  return fields.map((field) => (
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
  ));
}

interface DialogProps {
  converter: Converter & { options: SettingField[] };
  /** E.g. "Convert to X4 EPUB". */
  title: string;
  /** What's converted, e.g. a file's name. */
  what: string;
  onConvert(converter: Converter): void;
  onClose(): void;
}

/** Asks for a converter's options, then converts with them. */
export function ConvertOptionsDialog({ converter, title, what, onConvert, onClose }: DialogProps) {
  const [values, setValues] = useState(() => optionDefaults(converter.options));
  return (
    <Modal title={title} onClose={onClose}>
      <p>{what}</p>
      <ConvertOptions fields={converter.options} values={values} onChange={setValues} />
      <ModalFooter>
        <Button $variant="secondary" onClick={() => setValues(optionDefaults(converter.options))}>
          Defaults
        </Button>
        <Spacer />
        <Button $variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => onConvert(converter.withOptions?.(values) ?? converter)}>Convert</Button>
      </ModalFooter>
    </Modal>
  );
}
