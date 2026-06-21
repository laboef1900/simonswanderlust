import { buildServer } from './server.js';

const authToken = process.env.AUTH_TOKEN ?? '';
if (!authToken) {
  console.error('AUTH_TOKEN is required; refusing to start without it.');
  process.exit(1);
}

const app = buildServer({
  storageDir: process.env.STORAGE_DIR ?? '/data/images',
  baseUrl: process.env.PUBLIC_BASE_URL ?? 'https://img.simonswanderlust.com',
  authToken,
});

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`image uploader listening on :${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
