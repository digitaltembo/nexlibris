import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AboutDialog } from './AboutDialog';

const meta = {
  component: AboutDialog,
  args: {
    onClose: fn(),
    onGetStarted: fn(),
    downloads: { desktop: 'https://example.com/desktop', android: 'https://example.com/nexlibris.apk' },
  },
} satisfies Meta<typeof AboutDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Opened from the name in the top bar. iOS has no download yet. */
export const Default: Story = {};

/** Opened on its own for a new library, with Get started. */
export const FirstRun: Story = { args: { firstRun: true } };

/** In the Android app: its own download isn't offered. */
export const InAndroidApp: Story = { args: { app: 'android' } };

/** With every app available, iOS through TestFlight say. */
export const AllApps: Story = {
  args: { downloads: { desktop: 'https://example.com/desktop', android: 'https://example.com/nexlibris.apk', ios: 'https://testflight.apple.com/join/example' } },
};
