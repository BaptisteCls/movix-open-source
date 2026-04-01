import { buildSocialPreviewResponse } from '../_lib/socialPreview.js';

export async function onRequest(context) {
  return buildSocialPreviewResponse(context, 'movie');
}
