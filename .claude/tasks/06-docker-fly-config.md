# 06 — Полагодити збірку й конфіг

**Фаза:** 2 — Повернути бота в робочий стан
**Залежності:** 05
**Блокує:** 07

## Контекст

**Docker-образ, найімовірніше, жодного разу не збирався після коміту `c4c765e`.** `Dockerfile:1` — `node:18-alpine`, а `better-sqlite3@12.6.2` у `package-lock.json` декларує `"node": "20.x || 22.x || 23.x || 24.x || 25.x"`. `npm install --production` на `EBADENGINE` лише попередить, а далі піде збірка з вихідників через node-gyp, яка на alpine (musl, без prebuilds) або впаде, або дасть несумісний `.node`. Плюс Node 18 сам по собі вже EOL. `package.json:11` при цьому все ще заявляє `"node": ">=18.0.0"`.

**`.dockerignore` відсутній.** `Dockerfile:10` — `COPY . .`, тож в образ потрапляють `.git/` з повною історією, `.idea/`, `docs/`, локальний `data/bot.db` (а він, коли наповниться, міститиме реальні chat_id користувачів) і будь-який локальний `.env`.

**Конфлікт у `fly.toml`.** В одному блоці `[[vm]]` одночасно `memory = '1gb'` і `memory_mb = 256`. Незрозуміло, що виграє; фактично машина піднята як `shared-cpu-1x@256MB`.

**Health-check декоративний.** `index.js:51` піднімає HTTP-сервер, але в `fly.toml` немає ані `[checks]`, ані `[[http_service.checks]]` — Fly його не опитує. Порт існує лише щоб задовольнити `[http_service]`.

## Кроки

### Dockerfile

```dockerfile
FROM node:22-slim
```
Debian-slim замість alpine — glibc, тож `better-sqlite3` бере готові prebuilt-бінарники і `python3 make g++` більше не потрібні (образ менший, збірка швидша й передбачуваніша).

Також:
- `npm ci --omit=dev` замість `npm install --production` — інакше lockfile ігнорується й версії пливуть
- `ENV NODE_ENV=production`
- `USER node` — зараз процес іде під root
- підняти `engines.node` у `package.json` до `>=20`

### .dockerignore

```
.git
.gitignore
.idea
docs
.claude
data
node_modules
.env
.env.*
!.env.example
README.md
```

### fly.toml

- прибрати `memory = '1gb'`, лишити один спосіб задання пам'яті
- додати health-check:
  ```toml
  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"
    method = "GET"
    path = "/"
  ```
  (сам ендпойнт стане чесним у задачі 13 — зараз він віддає 200 навіть із мертвим polling-циклом)

## Критерії готовності

- [ ] `docker build -t deye-bot .` проходить локально без помилок і без EBADENGINE
- [ ] `docker run --rm deye-bot node -e "require('better-sqlite3')"` не падає
- [ ] `docker run --rm deye-bot ls -a /app` не містить `.git`, `.idea`, `docs`, `data/bot.db`
- [ ] Розмір образу зафіксовано до/після (очікується помітне зменшення без build-toolchain)
- [ ] `fly.toml` без конфлікту memory, з `[[http_service.checks]]`
