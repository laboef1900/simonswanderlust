# Long-running builder: holds the Astro toolchain, builds from Postgres at runtime,
# and atomically publishes into the shared /srv/blog volume that nginx serves.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV RELEASES_DIR=/srv/blog
EXPOSE 4000
VOLUME ["/srv/blog"]
CMD ["node", "build-server.mjs"]
