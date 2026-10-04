import type { StorybookConfig } from '@storybook/react-vite';

/** Stories sit next to their components (`src/**\/*.stories.tsx`); Vite's own config (`vite.config.ts`) applies. */
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.tsx'],
  framework: '@storybook/react-vite',
  core: { disableTelemetry: true },
};

export default config;
