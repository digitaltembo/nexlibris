import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { Reading } from '../library/currentlyReading';
import { sampleItems } from '../stories/sampleLibrary';
import { NoticeBox } from '../styles/ui';
import { CurrentlyReading } from './CurrentlyReading';

/** Sample books read part of the way, as the library's positions would give them. */
const reading: Reading[] = sampleItems
  .filter((item) => item.files.length)
  .slice(0, 4)
  .map((item, i) => ({
    item,
    file: item.files[0]!,
    position: { hash: item.files[0]!.hash, locator: 'epubcfi(/6/4)', ...(i !== 2 && { progress: [0.12, 0.47, 0, 0.83][i]! }), updatedAt: '2026-10-08T09:00:00.000Z' },
  }));

const meta = {
  component: CurrentlyReading,
  args: { reading, onRead: fn(), onSetAside: fn(), onHide: fn() },
  decorators: [
    (Story) => (
      <NoticeBox>
        <Story />
      </NoticeBox>
    ),
  ],
} satisfies Meta<typeof CurrentlyReading>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Above the books: one click reopens a book where it was left, × takes it out (keeping the place). */
export const InProgress: Story = {};

/** One book. */
export const OneBook: Story = { args: { reading: reading.slice(0, 1) } };
