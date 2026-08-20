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

# Apply any pending migrations, then start. Migration is non-fatal so a transient
# DB hiccup doesn't block the app; startup markers make the logs easy to read.
# The host injects PORT + secrets.
CMD ["sh", "-c", "echo '[startup] prisma migrate deploy...'; npx prisma migrate deploy || echo '[startup] migrate deploy FAILED (continuing)'; echo '[startup] starting app...'; node dist/main.js"]
