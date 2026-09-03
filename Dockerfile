FROM node:22-slim

# Debian-slim замість alpine: glibc, тож better-sqlite3 бере готові prebuilt
# бінарники і python3/make/g++ більше не потрібні. node:18-alpine не міг
# зібрати better-sqlite3@12 узагалі — той вимагає Node 20+.
ENV NODE_ENV=production
WORKDIR /app

# npm ci, а не npm install: інакше lockfile ігнорується й версії пливуть.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY *.js ./

# Каталог під SQLite: у проді сюди монтується волюм, локально — звичайна тека.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
CMD ["node", "index.js"]
