import { ApiReference } from '@scalar/nextjs-api-reference';

/**
 * The interactive API console.
 *
 * A route handler rather than a page: `ApiReference()` returns `() => Response`
 * and serves a complete HTML document, so there is no React component to
 * render and this directory cannot also hold a `page.tsx`.
 *
 * Public, and outside `(admin)` on purpose. It documents the key-authenticated
 * API for the people who call it, and every operation it can fire still needs a
 * Bearer key the visitor supplies themselves, so reading the page grants
 * nothing. The console sends real requests to whichever deployment served it:
 * a key pasted here spends that key's own quota against real provider calls.
 *
 * The reference bundle loads from jsDelivr at runtime -- the page is HTML plus
 * a CDN script tag, not a bundled dependency -- so the console needs public
 * network access from the browser to render.
 */
export const GET = ApiReference({
  url: '/api/openapi.json',
  pageTitle: 'API reference — media-name-parser',
});
