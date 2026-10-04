import type { Meta, StoryObj } from '@storybook/react-vite';
import { RichText } from './RichText';

const meta = { component: RichText } satisfies Meta<typeof RichText>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Paragraphs: Story = {
  args: {
    text: '<p>Emma Woodhouse, <em>handsome, clever, and rich</em>, with a comfortable home…</p><p>She was the youngest of the two daughters of a most affectionate, indulgent father.</p>',
  },
};

/** Tags outside the allowlist are dropped, scripts and event handlers included. */
export const Untrusted: Story = {
  args: {
    text: '<p onclick="alert(1)">Kept text, <b>bold</b> and a <a href="javascript:alert(1)">link</a>.</p><script>alert(1)</script><img src=x onerror=alert(1)>',
  },
};

export const PlainText: Story = { args: { text: 'A description with no markup.\n\nIn two paragraphs.' } };
