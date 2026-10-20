import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { Breadcrumbs, CrumbAction, CrumbCount } from './Breadcrumbs';
import { ViewSwitcher } from './ViewSwitcher';

const meta = {
  component: Breadcrumbs,
  args: { withPanel: false, crumbs: [] },
} satisfies Meta<typeof Breadcrumbs>;
export default meta;
type Story = StoryObj<typeof meta>;

const trail = (...labels: string[]) => labels.map((label) => ({ label, onSelect: fn() }));

/** Where the app starts: every book. */
export const AllBooks: Story = {
  args: {
    crumbs: trail('Library', 'All books'),
    children: (
      <>
        <CrumbCount>4 books</CrumbCount>
        <ViewSwitcher view="grid" onView={fn()} onSettings={fn()} />
      </>
    ),
  },
};

/** The Library: the categories to browse, with the user's own editable. */
export const Library: Story = {
  args: {
    crumbs: trail('Library'),
    children: (
      <>
        <CrumbCount>6 categories</CrumbCount>
        <CrumbAction onClick={fn()}>Edit categories…</CrumbAction>
      </>
    ),
  },
};

/** Deep in a category; on a phone the levels above shrink first. */
export const Deep: Story = {
  args: { crumbs: trail('Library', 'Tags', 'Detective and mystery stories'), children: <CrumbCount>8 books</CrumbCount> },
};
