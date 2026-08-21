# Portable image for the booking engine (works on Render/Railway/Fly/VPS).
FROM node:22-slim

# Prisma needs openssl at runtime.
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

ENV NODE_ENV=production
EXPOSE 3001

# Start the app directly so it binds the port fast on every (cold) start. The DB
# schema is applied out-of-band (run `npx prisma migrate deploy` from CI/locally
# against the prod DB when the schema changes) — running it here can hang boot.
CMD ["node", "dist/main.js"]
