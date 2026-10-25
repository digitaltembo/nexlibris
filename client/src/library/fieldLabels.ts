import { bookField, fieldLabel as fieldName, BOOK_FIELDS as FIELDS, type BookField } from '@nexlibris/common';
import { tIf } from '../i18n';

/**
 * The fixed fields as the UI shows them, labelled from the app's text (`fields`, `fieldHints`), which
 * replaces common's English labels where it has them.
 */
export const BOOK_FIELDS: BookField[] = FIELDS.map((field) => ({
  ...field,
  label: tIf(`fields.${field.key}`) ?? field.label,
  ...(field.hint !== undefined && { hint: tIf(`fieldHints.${field.key}`) ?? field.hint }),
}));

/** A field's label: a fixed field's from the app's text, else its key in words ("readingOrder" as "Reading order"). */
export const fieldLabel = (key: string): string => (bookField(key) && tIf(`fields.${key}`)) || fieldName(key);
