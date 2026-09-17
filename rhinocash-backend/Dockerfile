# Rhinocash backend — Node 20+ built-ins plus the pg driver. No build
# step (nothing to compile/bundle); this image just installs the one
# dependency and runs server.js directly.
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# data/uploads must be writable — it's where client documents and staff
# avatars land (server.js creates it automatically if missing, but this
# ensures the right ownership under a non-root user).
RUN useradd --system --create-home rhinocash \
    && mkdir -p data/uploads \
    && chown -R rhinocash:rhinocash /app
USER rhinocash

EXPOSE 4000

# DATABASE_URL is required and has no default — see .env.example.
# SESSION_SECRET/MPESA_ENCRYPTION_KEY should be set explicitly in any
# deployment with more than one instance or that needs stable sessions
# across restarts (see README.md "Configuration").
CMD ["node", "server.js"]
