FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV STORAGE_DIR=/data/images
ENV PORT=3000
VOLUME ["/data/images"]
EXPOSE 3000

CMD ["npm", "start"]
