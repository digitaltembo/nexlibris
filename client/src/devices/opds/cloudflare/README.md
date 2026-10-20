# Calibre3Opds Static Site Server

This directory holds everything needed to serve the catalog as a static website,
plus the Cloudflare Pages files for the export options you chose:

- **Search routing** (`functions/search/[[searchTerm]].js`, or inside `_worker.js`
  with Basic Auth): lets OPDS clients search as typed. A search such as
  `/search/Science Fiction/page-1.xml` is served from the static
  `/search/science-fiction/page-1.xml`, and any other query, such as
  `/search/lovelace/page-1.xml`, gets a paginated feed built from
  `search-index.json`.
- **Basic Auth** (`_worker.js`): puts HTTP Basic Auth in front of the whole site.
  Cloudflare Zero Trust, which is free for small teams, is a stronger option if
  you need one.

`.assetsignore` keeps these files, and this README, from being served.

To deploy:

```sh
npm install -g wrangler # installs the Cloudflare Wrangler tool
wrangler pages project create library # or any other name
# With Basic Auth only:
wrangler pages secret put BASIC_USER # prompts for the username
wrangler pages secret put BASIC_PASS # prompts for the password
wrangler pages deploy . --branch production
```
