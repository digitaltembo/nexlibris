import type { EpubBook } from '../epubBuilder';
import type { BookMetadata, Creator } from '../../metadata';

/** What a conversion carries over of a book's record (a nexlibris `Item` is one). */
export interface ConvertItem {
  title: string;
  creators: Creator[];
  identifiers: Record<string, string>;
  tags: string[];
  metadata: BookMetadata;
}

export interface ConvertContext {
  item: ConvertItem;
  /** The item's cover, if it has one, for embedding in the output. */
  cover?: { data: Blob; mediaType: string };
}

/** EPUB package metadata from library metadata, so conversions carry the user's edits. */
export function bookFromItem({ item, cover }: ConvertContext): Omit<EpubBook, 'chapters'> {
  const text = (key: string) => (typeof item.metadata[key] === 'string' ? (item.metadata[key] as string) : undefined);
  const seriesIndex = item.metadata.seriesIndex;
  return {
    title: item.title,
    creators: item.creators,
    language: text('language'),
    identifiers: item.identifiers,
    tags: item.tags,
    description: text('description'),
    publisher: text('publisher'),
    published: text('published'),
    series: text('series'),
    seriesIndex: typeof seriesIndex === 'number' ? seriesIndex : undefined,
    titleSort: text('titleSort'),
    authorSort: text('authorSort'),
    cover,
  };
}
