import { buildSocialPreviewResponse } from './_lib/socialPreview.js';

export async function onRequest(context) {
  const pathname = new URL(context.request.url).pathname;

  if (pathname.startsWith('/movie/') || pathname.startsWith('/tv/')) {
    return context.next();
  }

  return buildSocialPreviewResponse(context);
}
