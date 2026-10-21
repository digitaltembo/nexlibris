/** An option a tool asks for (a converter's, say), as a connection's settings are asked for. Values are strings. */
export interface OptionField {
  key: string;
  label: string;
  default: string;
  help?: string;
  /**
   * How it's asked for: free text (the default), a checkbox (`yes` or `no`), or some of `choices`,
   * stored as their values joined by commas (empty for all of them, the default).
   */
  kind?: 'text' | 'checkbox' | 'some';
  /** Offered as a list of choices rather than free text (or, for `some`, the ones to pick from). */
  choices?: { value: string; label: string }[];
  /** A whole number in this range. */
  range?: { min: number; max: number };
}
