FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js db.js ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3012

USER node
CMD ["node", "server.js"]
