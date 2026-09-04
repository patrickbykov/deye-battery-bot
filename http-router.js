// Мінімальний роутер: без фреймворка, без компіляції regexp, без залежностей.
// Машина має 256 MB, а таблиця маршрутів — сім рядків.

// '.' і '..' відхиляємо явно. new URL() їх нормалізує, але покладатись на це
// неявно не варто: читач коду має бачити, що шлях не може «піднятись» вище.
function split(pathname) {
  const segments = [];
  for (const segment of String(pathname).split('/')) {
    if (segment === '') continue;
    if (segment === '.' || segment === '..') return null;
    segments.push(segment);
  }
  return segments;
}

function matchSegments(pattern, actual) {
  if (pattern.length !== actual.length) return null;

  const params = {};
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i].startsWith(':')) params[pattern[i].slice(1)] = actual[i];
    else if (pattern[i] !== actual[i]) return null;
  }
  return params;
}

export function matchRoute(routes, method, pathname) {
  const actual = split(pathname);
  if (actual === null) return null;

  // Шлях знайшовся, але метод інший — це 405, не 404. Інакше помилка в
  // методі виглядала б як відсутній ендпойнт.
  let pathMatched = false;

  for (const route of routes) {
    const params = matchSegments(split(route.path) ?? [], actual);
    if (params === null) continue;
    if (route.method !== method) { pathMatched = true; continue; }
    return { handler: route.handler, params };
  }
  return pathMatched ? { methodMismatch: true } : null;
}
