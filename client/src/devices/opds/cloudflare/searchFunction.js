/**
 * Cloudflare Pages Function, exported to functions/search/[[searchTerm]].js when
 * search routing is enabled without Basic Auth. It answers OPDS searches such as
 * `/search/Science Fiction/page-1.xml` from the exported search-index.json.
 * _worker.js does the same when Basic Auth is enabled.
 */

// BEGIN SEARCH (identical in _worker.js; tests/test_exporter.py checks this)
const SEARCH_INDEX = "/search-index.json";
// Matches the type static hosts give the exported feeds
const FEED_TYPE = "application/xml";

// Must match _slug in exporter.py, less its "untitled" fallback
function normalize(value) {
  return value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

// The normalized query and page of a search URL, or null when it is not one.
// The bare `/search/<query>.xml` form is the template older exports advertised.
function searchRequest(pathname) {
  const match = pathname.match(/^\/search\/(.+?)(?:\/page-(\d+))?\.xml$/);
  if (!match) return null;
  try {
    return { query: normalize(decodeURIComponent(match[1])), page: Number(match[2] || 1) };
  } catch {
    return null;
  }
}

// Loaded once per isolate; a failed load is retried by the next search
let searchIndex = null;
function loadSearchIndex(env, url) {
  if (!searchIndex) {
    searchIndex = env.ASSETS.fetch(new URL(SEARCH_INDEX, url).toString())
      .then((response) => {
        if (!response.ok) throw new Error(`${SEARCH_INDEX}: HTTP ${response.status}`);
        return response.json();
      })
      .then((index) => ({ ...index, terms: new Set(index.books.flatMap((book) => book.terms)) }));
    searchIndex.catch(() => {
      searchIndex = null;
    });
  }
  return searchIndex;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// An acquisition feed laid out like the exporter's static paged feeds
function searchFeed(index, query, page, pages, books) {
  const dir = `/search/${query}`;
  const link = (rel, n) => `<link rel="${rel}" href="${dir}/page-${n}.xml" type="application/atom+xml" />`;
  const start = (page - 1) * index.pageSize;
  const parts = [
    "<?xml version='1.0' encoding='utf-8'?>",
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">',
    `<id>urn:calibre:search/${query}:${page}</id>`,
    `<title>Search: ${query}</title>`,
    `<updated>${escapeXml(index.updated)}</updated>`,
    `<link rel="self" href="${dir}/page-${page}.xml" />`,
    '<link rel="search" href="/searchDescription.xml" type="application/opensearchdescription+xml" />',
    '<link rel="search" href="/search/{searchTerms}/page-1.xml" type="application/atom+xml" />',
    '<link rel="subsection" href="/navigation/index.xml" type="application/atom+xml" />',
    `<opensearch:totalResults>${books.length}</opensearch:totalResults>`,
    `<opensearch:startIndex>${start}</opensearch:startIndex>`,
    `<opensearch:itemsPerPage>${index.pageSize}</opensearch:itemsPerPage>`,
  ];
  if (pages > 1) parts.push(link("first", 1), link("last", pages));
  if (page > 1) parts.push(link("previous", page - 1));
  for (const book of books.slice(start, start + index.pageSize)) parts.push(book.entry);
  if (page < pages) parts.push(link("next", page + 1));
  parts.push("</feed>");
  return parts.join("");
}

// The response to a search URL, or null for any other request. A query that
// is exactly a term gets that term's static feed; any other query matches the
// books where every word of it is part of one of their terms.
async function search(request, env) {
  const url = new URL(request.url);
  const wanted = searchRequest(url.pathname);
  if (!wanted) return null;
  const { query, page } = wanted;

  let index;
  try {
    index = await loadSearchIndex(env, url);
  } catch (error) {
    console.error(error);
    // Without the index, only an exact term's static feed can answer
    url.pathname = `/search/${query}/page-${page}.xml`;
    return env.ASSETS.fetch(new Request(url.toString(), request));
  }

  const exact = index.terms.has(query);
  const words = query.split("-").filter(Boolean);
  const books = exact
    ? index.books.filter((book) => book.terms.includes(query))
    : index.books.filter(
        (book) => words.length > 0 && words.every((word) => book.terms.some((term) => term.includes(word))),
      );
  const pages = Math.max(1, Math.ceil(books.length / index.pageSize));
  if (page < 1 || page > pages) return new Response("Not found", { status: 404 });
  if (exact) {
    url.pathname = `/search/${query}/page-${page}.xml`;
    return env.ASSETS.fetch(new Request(url.toString(), request));
  }
  return new Response(searchFeed(index, query, page, pages, books), { headers: { "Content-Type": FEED_TYPE } });
}
// END SEARCH

export async function onRequest({ request, env }) {
  return (await search(request, env)) || env.ASSETS.fetch(request);
}
