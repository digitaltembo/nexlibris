# @nexlibris/server

The [nexlibris](https://github.com/digitaltembo/nexlibris) server, to run yourself: it serves the nexlibris web app, with accounts, and keeps each account's library (books' files on disk or in an S3-compatible bucket: AWS, Google Cloud Storage, Backblaze B2, MinIO, R2). Signed in, a browser keeps its library in the account, or keeps it and syncs with it; the desktop and phone apps sign in to it by its address. It also serves each account's OPDS feeds live, for e-readers.

```sh
npx @nexlibris/server serve --port 8080 --data ./nexlibris-data
npx @nexlibris/server add-account ada         # password from NEXLIBRIS_PASSWORD, else asked
npx @nexlibris/server help                    # every option, each an environment variable too
```

Or installed, `npm install -g @nexlibris/server`, as `nexlibris-server`. It needs Node 24 or later, and nothing else: the server is one file, with the web app beside it. The first account can sign up from the web (`--signup open|first|closed`); behind a proxy that terminates https, add `--trust-proxy`.

The same server as a Docker image: `ghcr.io/digitaltembo/nexlibris`. Under the MIT licence.
