FROM node:20-slim

# Install build tools needed for better-sqlite3 native bindings
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/whispering.db

EXPOSE 3000

CMD ["node", "server.js"]
