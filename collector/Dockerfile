FROM node:22-slim

# Жодного npm install: колектор обходиться вбудованими fetch, crypto і http.
# Немає залежностей — немає ні node-gyp, ні prebuilds, ні вразливостей у них.
ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY *.js ./

USER node
CMD ["node", "index.js"]
