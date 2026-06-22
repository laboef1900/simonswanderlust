import { buildServer } from './server.js';
import { captionImage } from './caption.js';

const authToken = process.env.AUTH_TOKEN ?? '';
if (!authToken) {
  console.error('AUTH_TOKEN is required; refusing to start without it.');
  process.exit(1);
}

const lmBaseUrl = process.env.LMSTUDIO_BASE_URL ?? 'http://host.docker.internal:1234/v1';
const lmModel = process.env.LMSTUDIO_MODEL ?? 'qwen/qwen3-vl-4b';
const captionTimeoutMs = Number(process.env.CAPTION_TIMEOUT_MS ?? 60000);
const captionMaxEdge = Number(process.env.CAPTION_MAX_EDGE ?? 768);

const app = buildServer({
  storageDir: process.env.STORAGE_DIR ?? '/data/images',
  baseUrl: process.env.PUBLIC_BASE_URL ?? 'https://img.simonswanderlust.com',
  authToken,
  captionMaxEdge,
  captioner: (jpeg) => captionImage(jpeg, { baseUrl: lmBaseUrl, model: lmModel, timeoutMs: captionTimeoutMs }),
});

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`image uploader listening on :${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
