# MODE MANUAL: jalankan dulu `npm install --omit=dev` di folder backend (di host).
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
COPY node_modules ./node_modules
COPY server.js features.js ./
RUN mkdir -p /app/data/uploads /app/data/backups && chown -R node:node /app/data
USER node
EXPOSE 5000
CMD ["node", "server.js"]
