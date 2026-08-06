# 05 — Полагодити зламану гілку

**Фаза:** 2 — Повернути бота в робочий стан
**Залежності:** немає (можна робити паралельно з фазою 1)
**Блокує:** 06, 07

## Контекст

Гілка `feature/multi-inverter` **не запускається**. Виконання плану multi-inverter зупинилось посеред задачі 4 з 10, залишивши код у неконсистентному стані.

**Поломка 1 — крах на старті.** `commands.js:2`:
```js
import { TG_API, INFLUXDB_BUCKET, DASHBOARD_LINK } from './config.js';
```
Коміт `7958f52` видалив `DASHBOARD_LINK` з `config.js`. В ESM це помилка **лінкування**, не рантайму: `node index.js` падає з `SyntaxError: The requested module './config.js' does not provide an export named 'DASHBOARD_LINK'` ще до виконання `main()`. Використання лишились у `commands.js:39`, `:64`, `:68`.

Заміна вже написана — `getDashboardLink(inverter)` у `grafana.js:44`, — але **не імпортована ніде** й сам файл не закомічений.

**Поломка 2 — arity.** `commands.js:50` викликає `renderGrafanaPanel()` без аргументу, а незакомічений `grafana.js:30` одразу робить `inverter.dashboard_uid` → `TypeError`.

`node --check commands.js` (крок верифікації у вихідному плані) **цього не ловить** — він лише парсить синтаксис. Саме тому поломка й проскочила.

**Мертвий код.** Таблиця `alert_state` у `db.js` існує для `alerts.js`, який ми не пишемо (алерти лишаються в Grafana). Прибрати, щоб не тягнути схему, яку ніхто не використовує.

**Ризик втрати.** Тека `docs/` — untracked. Дизайн-док і 27-кілобайтний план існують лише локально й за один `git clean -fd` від зникнення.

## Кроки

1. Закомітити `docs/` **першим комітом** — до будь-яких змін коду.
2. `commands.js`: імпортувати `getDashboardLink` з `./grafana.js`, прибрати `DASHBOARD_LINK` з імпорту `config.js`, замінити три використання.
3. `commands.js`: `handleStatus`/`handleGraph` приймають об'єкт інвертора; прибрати хардкод `r.inverter == "Deye-SUN-15K"` (`commands.js:12`) — фільтр будується з переданого id.
4. Тимчасовий міст до задачі 10: поки `commands.js` ще не переписаний під підписки, роутинг має підставляти дефолтний інвертор з env або першого рядка таблиці `inverters` — щоб гілка була робочою вже зараз.
5. Закомітити `grafana.js` разом із виправленим `commands.js` — **не окремо**, бо поодинці він лише погіршує стан.
6. `db.js`: прибрати `CREATE TABLE alert_state` і функції `getAlertState`, `setAlertActive`, `clearAlert`.

## Критерії готовності

- [ ] `git status` чистий, `docs/` у git
- [ ] `node index.js` стартує без `SyntaxError` (з мінімальним набором env-змінних)
- [ ] `grep -rn "DASHBOARD_LINK" *.js` → порожньо
- [ ] `grep -rn "Deye-SUN-15K" *.js` → порожньо
- [ ] `grep -rn "alert_state" *.js` → порожньо
- [ ] Після того як 04 запрацює: `/status` у Telegram віддає живі цифри

## Нотатка

`node --check` як єдиний засіб перевірки більше не використовувати — він не ловить помилки лінкування ESM. Мінімум: реальний запуск `node index.js` зі змінними оточення.
