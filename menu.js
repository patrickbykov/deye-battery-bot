// Щоденне — зверху. Telegram показує цей список у тому порядку, у якому його
// надіслано, тож /status і /graph мають бути першими: підписку налаштовують
// раз, а стан дивляться постійно.
export const USER_MENU = [
  { command: 'status', description: '🔋 Поточний стан' },
  { command: 'graph', description: '📊 Графік за 24 години' },
  { command: 'outages', description: '⚡ Скільки не було світла' },
  { command: 'list', description: '📋 Доступні об’єкти' },
  { command: 'subscribe', description: '➕ Обрати об’єкти' },
  { command: 'mysubs', description: '📌 Мої підписки' },
  { command: 'unsubscribe', description: '➖ Відписатись' },
  { command: 'forgetme', description: '🗑 Видалити мої дані' },
  { command: 'help', description: 'ℹ️ Список команд' },
];

// Ставиться зі scope chat на ADMIN_CHAT_ID. Такий список ЗАМІНЮЄ типовий для
// цього чату, тож містить і все користувацьке. Решті людей адмінські команди
// не показуються — як і не відповідають їм.
export const ADMIN_MENU = [
  ...USER_MENU.slice(0, 3),
  { command: 'pause', description: '⏸ Пауза сповіщень для всіх' },
  { command: 'resume', description: '▶️ Відновити сповіщення' },
  { command: 'users', description: '👥 Користувачі' },
  { command: 'export', description: '💾 Дамп бази' },
  ...USER_MENU.slice(3),
];
