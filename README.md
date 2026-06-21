# simonswanderlust-images

Self-hosted image uploader for the Astro blog. Uploads a photo, generates
responsive AVIF/WebP variants (EXIF/GPS preserved), stores them on this
server, and returns a `heroImage` YAML snippet to paste into a post.

## Contract

Filenames: `{key}-{width}.{format}` at widths 640/1280/1920 (plus the source's
own width, never upscaled), formats `avif` + `webp`. Must match the blog's
`site/src/lib/images.ts`. Variants are served with a one-year immutable cache.

## Run (Docker)

1. `cp .env.example .env` and set a long random `AUTH_TOKEN`.
2. `docker compose up -d --build`
3. Put your reverse proxy in front: map `https://img.simonswanderlust.com` →
   this container's port 3000, terminate TLS there.
4. Open `https://img.simonswanderlust.com/admin/`, enter the token, upload.

## Batch (Phase 2 migration)

```bash
STORAGE_DIR=./data/images PUBLIC_BASE_URL=https://img.simonswanderlust.com \
  npm run upload -- ./photo.jpg trips/bucharest-2024/hero "Old town at dusk"
```

Prints the paste-ready `heroImage:` snippet and writes all variants under
`STORAGE_DIR`.

## Develop

`npm install` · `npm test` · `npm run typecheck` · `npm run dev`

To smoke-test the container by hand (needs a running Docker daemon), generate a
throwaway JPEG instead of committing one:

```bash
node -e "require('sharp')({create:{width:1200,height:800,channels:3,background:'#345'}}).jpeg().toFile('/tmp/sample.jpg')"
AUTH_TOKEN=secret docker compose up -d --build
curl -s -X POST http://localhost:3000/upload -H "authorization: Bearer secret" \
  -F key=trips/smoke/hero -F alt=smoke -F file=@/tmp/sample.jpg
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/trips/smoke/hero-640.webp  # -> 200
docker compose down
```
