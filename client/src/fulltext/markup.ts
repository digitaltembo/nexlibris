import type { ChildNode, Document, Element } from 'domhandler';
import { decodeHTML } from 'entities';
import { parseDocument } from 'htmlparser2';

/**
 * XML and XHTML read without a browser DOM, so books' text can be extracted in a worker (which has
 * no `DOMParser`) the same as anywhere else. Parsed as XML, as a reader loads an EPUB's XHTML, so
 * elements nest as they do there and CFI paths agree; HTML's named entities (`&nbsp;`) are
 * decoded too, as books use them without declaring them. Malformed markup is read as best it can be.
 */

export type { Document, Element };

export const parseMarkup = (source: string): Document => parseDocument(source, { xmlMode: true, decodeEntities: false });

export const isElement = (node: ChildNode): node is Element => node.type === 'tag' || node.type === 'script' || node.type === 'style';

/** An element's name without its namespace prefix (`navPoint`, `title` for `dc:title`). */
export const localName = (el: Element) => el.name.slice(el.name.indexOf(':') + 1);

export const childElements = (node: Document | Element): Element[] => node.children.filter(isElement);

/** The document's root element. */
export const rootElement = (doc: Document) => childElements(doc)[0];

/** Every element below `root` with this local name, in document order. */
export function byLocalName(root: Document | Element, name: string): Element[] {
  const found: Element[] = [];
  const visit = (node: Document | Element) => {
    for (const child of childElements(node)) {
      if (localName(child) === name) found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

/** An attribute's value, entities decoded; by its full name (`epub:type`). */
export function attribute(el: Element, name: string): string | undefined {
  const value = el.attribs[name];
  return value === undefined ? undefined : decodeHTML(value);
}

/** A text node's text, entities decoded. */
export const nodeText = (data: string) => (data.includes('&') ? decodeHTML(data) : data);

/** All the text below a node. */
export function textContent(node: Document | Element): string {
  let text = '';
  for (const child of node.children) {
    if (child.type === 'text') text += nodeText(child.data);
    else if (child.type === 'cdata') text += textContent(child as unknown as Element);
    else if (isElement(child)) text += textContent(child);
  }
  return text;
}
