import { assertImage, resolvePublicHost, safeFetch, validatePublicUrl } from './collector-security.js';

export const IMAGE_LIMIT = 6 * 1024 * 1024;

/** The name routes one image URL to one independent request budget. */
export async function imageResourceId(value) {
  const url = validatePublicUrl(value).href;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url)));
  return `image:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Every redirect and DNS answer receives the same checks as an article request. */
export async function fetchImageResource(url, { fetchImpl = fetch, resolveHost = resolvePublicHost } = {}) {
  const image = await safeFetch(url, { fetchImpl, resolveHost, maxBytes: IMAGE_LIMIT, accept: 'image/*' });
  return { url: image.url, bytes: image.bytes, contentType: assertImage(image.bytes, image.contentType) };
}
