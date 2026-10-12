import { createDevice } from '@nexlibris/common';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { TextFetcher } from '../catalogs/remote';
import { CatalogBrowser } from './CatalogBrowser';

/** A catalog in the layout nexlibris exports (calibre3opds's), served from memory: three pages of books and a section. */
const ROOT = 'https://catalog.example/index.xml';
const cover = (hue: number) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="60" height="90"><rect width="60" height="90" fill="hsl(${hue} 45% 45%)"/></svg>`)}`;
const book = (n: number) => `<entry><id>urn:book:${n}</id><title>Book ${n}</title><author><name>Author ${n % 4}</name></author>
<summary type="html">&lt;p&gt;The ${n}th book of the catalog.&lt;/p&gt;</summary>
<link rel="http://opds-spec.org/acquisition" href="/books/${n}.epub" type="application/epub+zip" length="${120000 * n}"/>
<link rel="http://opds-spec.org/image" href="${cover(n * 37)}" type="image/svg+xml"/>
<category>${['Fantasy', 'Mystery', 'Classics'][n % 3]}</category>${n % 2 ? `<calibre:series xmlns:calibre="http://calibre-ebook.com">Saga ${n % 3}</calibre:series>` : ''}
<link rel="related" href="/authors/${n % 4}.xml" type="application/atom+xml;profile=opds-catalog" title="By Author ${n % 4}"/></entry>`;
const page = (n: number) => `<feed xmlns="http://www.w3.org/2005/Atom"><title>Library</title>
<link rel="search" href="/search/{searchTerms}/page-1.xml" type="application/atom+xml"/>
<link rel="subsection" href="/navigation/index.xml" type="application/atom+xml"/>
${n < 3 ? `<link rel="next" href="/page-${n + 1}.xml" type="application/atom+xml"/>` : ''}
${Array.from({ length: 8 }, (_, i) => book((n - 1) * 8 + i + 1)).join('\n')}</feed>`;
const PAGES: Record<string, string> = {
  [ROOT]: page(1),
  'https://catalog.example/page-2.xml': page(2),
  'https://catalog.example/page-3.xml': page(3),
  'https://catalog.example/navigation/index.xml': `<feed xmlns="http://www.w3.org/2005/Atom"><title>Browse</title>
${['Recent books', 'Authors', 'Series', 'Tags'].map((t, i) => `<entry><id>nav:${i}</id><title>${t}</title><content type="text">${(i + 1) * 12} entries</content><link rel="subsection" href="/navigation/${i}.xml" type="application/atom+xml"/></entry>`).join('')}</feed>`,
};

const fakeServer: TextFetcher = async (url) => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const text = PAGES[url];
  return text ? { status: 200, url, text } : { status: 404, url, text: '' };
};
const offline: TextFetcher = async (url) => {
  throw new Error(`Couldn’t reach ${new URL(url).host}. Check the address and your connection.`);
};

const device = createDevice({ name: 'Public library', type: 'opds.server', settings: { url: ROOT } });

/** Following links within the story, as the Library does with its path. */
function Browsing({ fetcher, view = 'grid' }: { fetcher: TextFetcher; view?: string }) {
  const [step, setStep] = useState<string>();
  return (
    <CatalogBrowser key={step ?? ROOT} device={device} root={ROOT} {...(step && { step })} onOpen={setStep} view={view} fetcher={fetcher} />
  );
}

const meta = {
  component: Browsing,
  args: { fetcher: fakeServer },
} satisfies Meta<typeof Browsing>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A catalog's first page: its section, its books, and Load more for the next page. */
export const Catalog: Story = {};

/** The same books as the library's list shows its own. */
export const AsList: Story = { args: { view: 'list' } };

/** On the bookshelf, as any of the library's views. */
export const OnBookshelf: Story = { args: { view: 'bookshelf.shelf' } };

/** A catalog that can't be reached (and wasn't read before). */
export const Unreachable: Story = { args: { fetcher: offline } };
