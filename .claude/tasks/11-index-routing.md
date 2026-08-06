# 11 — Переписати `index.js`

**Фаза:** 3 — Multi-inverter
**Залежності:** 10
**Блокує:** 12

## Контекст

`index.js` роутить лише команди без аргументів через `commands[text]` і не знає ні про адмінів, ні про discovery, ні про сигнали ОС.

Три окремі проблеми, які варто закрити разом.

**Немає graceful shutdown.** `grep -rn "SIGTERM|SIGINT|process.on|db.close"` по всьому репо → **нуль збігів**. Fly шле `SIGTERM` на кожному деплої й рестарті машини; процес добивається `SIGKILL` посеред `await`. `db.js:9` відкриває SQLite у WAL-режимі й **ніколи не закриває** — `bot.db-wal` росте, а відновлення лишається наступному відкриттю. На волюмі з жорсткими вбивствами це реальний ризик.

**Лукап хендлера через прототип.** `index.js:28`:
```js
const handler = commands[text];
if (handler) await handler(msg.chat.id);
```
`commands` — звичайний об'єктний літерал (`commands.js:95`). Користувач шле `__proto__` (уже зведений до нижнього регістру на `index.js:25`) → отримуємо truthy не-функцію → `TypeError: handler is not a function`. Виняток вилітає з `processUpdate`, ловиться в `pollUpdates` і **обриває обробку решти батча**. `constructor` дає виклик `Object(chatId)`. Та сама діра для `callback_data` на `index.js:16`.

**`setMyCommands` без try/catch.** `index.js:75` — єдиний незахищений `await` у `main()`. Якщо він відхилиться, `main()` кине, `main().catch(console.error)` (`index.js:95`) лише залогує, **polling-цикл не стартує взагалі** — але HTTP-сервер із `index.js:51` тримає event loop живим і далі віддає 200. Процес виглядає здоровим і не обслуговує нікого.

## Кроки

1. Роутинг simple/arg-команд через `parseCommand` із задачі 10.
2. Адмінські команди за `ADMIN_CHAT_ID`:
   - `/remove_inverter <id>` — `removeInverter()`, каскадом знімає підписки
   - `/users` — список користувачів і їхніх підписок
   Не-адміну — та сама відповідь, що й на невідому команду (не «доступ заборонено», щоб не світити існування).
3. Запуск discovery-циклу з задачі 09.
4. `setMyCommands` з повним списком: `list`, `subscribe`, `unsubscribe`, `mysubs`, `status`, `graph`, `help`. Обгорнути в try/catch — падіння реєстрації команд не має заважати боту працювати.
5. Лукап через `Map` або `Object.create(null)`; додатково перевіряти `typeof handler === 'function'`.
6. Graceful shutdown:
   ```js
   const shutdown = (sig) => {
     running = false;
     try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch {}
     process.exit(0);
   };
   process.on('SIGTERM', () => shutdown('SIGTERM'));
   process.on('SIGINT',  () => shutdown('SIGINT'));
   ```
   Замінити `while (true)` на прапорець, щоб цикл коректно завершувався.
7. `process.on('unhandledRejection')` / `'uncaughtException'` — логувати, а не мовчки лишати процес у невизначеному стані.
8. `index.js:41` просуває `lastUpdateId` **до** виклику `processUpdate`. Виняток у хендлері пропускає апдейт назавжди — перенести просування після успішної обробки або обгорнути кожен апдейт окремим try/catch, щоб один збій не забирав увесь батч.
9. Прибрати логування `msg.from.first_name` і повного тексту повідомлення (`index.js:14`, `:26`) — див. задачу 13.

## Критерії готовності

- [ ] Усі команди з задачі 10 роутяться, включно з аргументами
- [ ] `/remove_inverter` і `/users` працюють лише з `ADMIN_CHAT_ID`
- [ ] Надсилання `__proto__` і `constructor` боту нічого не ламає
- [ ] `kill -TERM <pid>` → у логах видно коректне завершення, `bot.db-wal` зчищений
- [ ] `fly deploy` не лишає файлів `-wal`/`-shm` розміром більше нуля після рестарту
- [ ] Виняток в одному апдейті не з'їдає решту батча
- [ ] Список команд у меню Telegram оновився
