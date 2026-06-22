import { buildServer, type Captioner } from './server.js';
import { captionImage } from './caption.js';

const authToken = process.env.AUTH_TOKEN ?? '';
if (!authToken) {
  console.error('AUTH_TOKEN is required; refusing to start without it.');
  process.exit(1);
}

const lmStudioBaseUrl = process.env.LMSTUDIO_BASE_URL ?? '';
const lmStudioModel = process.env.LMSTUDIO_MODEL ?? '';
const captioner: Captioner | undefined =
  lmStudioBaseUrl && lmStudioModel
    ? (jpeg) => captionImage(jpeg, { baseUrl: lmStudioBaseUrl, model: lmStudioModel })
    : undefined;

if (!captioner) {
  console.warn('LMSTUDIO_BASE_URL or LMSTUDIO_MODEL not set — /suggest will return captionError for every row.');
}

const app = buildServer({
  storageDir: process.env.STORAGE_DIR ?? '/data/images',
  baseUrl: process.env.PUBLIC_BASE_URL ?? 'https://img.simonswanderlust.com',
  authToken,
  captioner,
  captionMaxEdge: process.env.CAPTION_MAX_EDGE ? Number(process.env.CAPTION_MAX_EDGE) : undefined,
});

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`image uploader listening on :${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
