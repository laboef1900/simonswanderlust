import { identity } from '../lib/build-identity';

export const prerender = true;

export function GET(): Response {
  const body = identity.canonicalOrigin === null
    ? 'User-agent: *\nDisallow: /\n'
    : `User-agent: *\nAllow: /\n\nSitemap: ${identity.canonicalOrigin}/sitemap-index.xml\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
