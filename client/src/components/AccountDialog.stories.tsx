import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { SignInScreen } from '../library/LibraryContext';
import { AccountDialog } from './AccountDialog';

const server = { name: 'books.example.org', signup: false };

const meta = {
  component: AccountDialog,
  args: { onClose: fn(), onLibraryFolder: fn(), session: server, place: { kind: 'browser' } },
} satisfies Meta<typeof AccountDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Signed out, on a server that takes no new accounts. */
export const SignedOut: Story = {};

/** Signed out, on a server that takes new accounts: making one is offered. */
export const SignUpOpen: Story = { args: { session: { ...server, signup: true } } };

/** Signed in, with the library still in this browser. */
export const SignedIn: Story = { args: { session: { ...server, account: { id: 'a', name: 'ada' } } } };

/** Signed in, with the library in the account. */
export const LibraryInAccount: Story = {
  args: { session: { ...server, account: { id: 'a', name: 'ada' } }, place: { kind: 'cloud', name: 'ada' } },
};

/** Opening a library kept in the account while signed out: the page asks to sign in first. */
export const SigningInToOpen: Story = {
  render: () => <SignInScreen session={{ ...server, signup: true }} onSignedIn={fn()} onUseBrowser={fn()} />,
};

/** The library is in the account, and the page can't reach the server. */
export const ServerUnreachable: Story = {
  render: () => <SignInScreen session={undefined} onSignedIn={fn()} onUseBrowser={fn()} />,
};

/** In the desktop or Android app, before a server is chosen: its address is asked for. */
export const AppChoosingServer: Story = { args: { app: true, session: undefined, reachable: true } };

/** In an app, signed out of the server it chose (one someone runs themselves, say). */
export const AppSignedOut: Story = { args: { app: true, server: 'http://192.168.1.20:8080', session: { ...server, name: 'Home library' } } };

/** In an app, signed in, with the library still on the device. */
export const AppSignedIn: Story = {
  args: { app: true, server: 'https://books.example.org', session: { ...server, account: { id: 'a', name: 'ada' } }, place: { kind: 'app', app: 'desktop', name: '' } },
};

/** In an app whose server doesn't answer. */
export const AppServerUnreachable: Story = { args: { app: true, server: 'https://books.example.org', session: undefined, reachable: false } };
