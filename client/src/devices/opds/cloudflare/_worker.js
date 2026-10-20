/**
 * Cloudflare Pages worker, exported when Basic Auth is enabled. It puts HTTP
 * Basic Auth, checked against the BASIC_USER and BASIC_PASS secrets, in front of
 * the whole site. Pages ignores functions/ while this file exists, so it also
 * routes searches when search routing is enabled.
 */

// Set by the exporter from the search routing option
const ROUTE_SEARCH = false;

const UNAUTHORIZED = () =>
  new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Library", charset="UTF-8"' },
  });

// BEGIN SEARCH (identical in [[searchTerm]].js; tests/test_exporter.py checks this)
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

// Compares in constant time, so a wrong guess reveals nothing by its timing
function equal(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) {
    crypto.subtle.timingSafeEqual(left, left);
    return false;
  }
  return crypto.subtle.timingSafeEqual(left, right);
}

function authorized(header, env) {
  const [scheme, encoded] = (header || "").split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  let decoded;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
  } catch {
    return false;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  const userOk = equal(decoded.slice(0, colon), env.BASIC_USER);
  const passOk = equal(decoded.slice(colon + 1), env.BASIC_PASS);
  return userOk && passOk;
}

export default {
  async fetch(request, env) {
    if (!env.BASIC_USER || !env.BASIC_PASS) {
      return new Response("BASIC_USER and BASIC_PASS are not set", { status: 500 });
    }
    if (!authorized(request.headers.get("Authorization"), env)) return UNAUTHORIZED();

    const response = ROUTE_SEARCH ? await search(request, env) : null;
    return response || env.ASSETS.fetch(request);
  },
};
