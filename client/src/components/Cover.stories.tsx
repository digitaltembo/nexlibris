import type { Meta, StoryObj } from '@storybook/react-vite';
import styled from 'styled-components';
import { sampleItems } from '../stories/sampleLibrary';
import { Cover } from './Cover';

const Sized = styled(Cover)`
  width: 160px;
`;

const meta = { component: Sized, args: { item: sampleItems[0]! } } satisfies Meta<typeof Sized>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithCover: Story = {};

/** An item without a cover gets a placeholder with its title. */
export const Placeholder: Story = { args: { item: sampleItems.find((item) => !item.cover)! } };
