//  SuperTux
//  Copyright (C) 2026 ponyo877
//
//  This program is free software: you can redistribute it and/or modify
//  it under the terms of the GNU General Public License as published by
//  the Free Software Foundation, either version 3 of the License, or
//  (at your option) any later version.
//
//  This program is distributed in the hope that it will be useful,
//  but WITHOUT ANY WARRANTY; without even the implied warranty of
//  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//  GNU General Public License for more details.
//
//  You should have received a copy of the GNU General Public License
//  along with this program.  If not, see <http://www.gnu.org/licenses/>.

// Serves the web build on Cloudflare (see tools/web/deploy.sh). Every file is
// a static asset except the data package: at ~330 MB it is over the limits
// of Workers assets (25 MiB per file) and of Wrangler's R2 uploads (300 MiB
// per object), so it sits in R2 in parts, data/<DATA_VERSION>/0, 1, ..., and
// is streamed back here as one file. Only requests that match no asset reach
// this code.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/supertux2.data")
      return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });

    const etag = `"${env.DATA_VERSION}"`;
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      ETag: etag,
      // The page keeps the package in IndexedDB; a new build comes with a
      // new package, so never serve a stale one from an HTTP cache.
      "Cache-Control": "no-cache",
    });
    if (request.headers.get("If-None-Match") === etag)
      return new Response(null, { status: 304, headers });

    const keys = Array.from({ length: Number(env.DATA_PARTS) }, (_, i) => `data/${env.DATA_VERSION}/${i}`);
    const parts = await Promise.all(keys.map((key) => env.DATA.head(key)));
    if (keys.length === 0 || parts.some((part) => !part))
      return new Response("The data package is not uploaded", { status: 503 });
    const size = parts.reduce((total, part) => total + part.size, 0);
    headers.set("Content-Length", String(size));
    if (request.method === "HEAD")
      return new Response(null, { headers });

    const { readable, writable } = new FixedLengthStream(size);
    ctx.waitUntil((async () => {
      for (const key of keys) {
        const part = await env.DATA.get(key);
        await part.body.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    })());
    return new Response(readable, { headers });
  },
};
