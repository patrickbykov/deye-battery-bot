import http from 'node:http';
import { matchRoute } from './http-router.js';
import { redact } from './helpers.js';

// Заголовки для всього, крім health. CSP тут не косметика: ім'я користувача
// приходить з Telegram довільним Unicode і потрапляє в HTML адмінки.
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
};

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readBody(req, { limitBytes, timeoutMs = 10_000 }) {
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => req.destroy(new Error('body-timeout')), timeoutMs);
  try {
    for await (const chunk of req) {
      size += chunk.length;
      // Стеля обов'язкова: на машині з 256 MB нічого не читаємо в пам'ять
      // без межі, інакше один запит валить процес.
      if (size > limitBytes) {
        req.destroy();
        throw new HttpError(413, 'payload too large');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

function respond(res, status, contentType, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': contentType, ...extraHeaders });
  res.end(body);
}

export function createHttpServer({ getHealth, routes, log }) {
  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return respond(res, 400, 'text/plain', 'bad request');
    }

    // Health — першим, окремо, без БД і без auth. Fly б'є сюди кожні 30 с і
    // має отримати відповідь навіть якщо решта застосунку зламана: провалений
    // check рестартить єдину машину, а рестарт нічого не лікує.
    if (pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      const { healthy, ageMs } = getHealth();
      const text = healthy
        ? `OK (останній полінг ${Math.round(ageMs / 1000)}с тому)`
        : `STALE (${ageMs === null ? 'полінгу ще не було' : Math.round(ageMs / 1000) + 'с без відповіді Telegram'})`;
      return respond(res, healthy ? 200 : 503, 'text/plain; charset=utf-8', text);
    }

    try {
      const route = matchRoute(routes, req.method, pathname);
      if (!route) return respond(res, 404, 'text/plain', 'not found', SECURITY_HEADERS);
      if (route.methodMismatch) {
        return respond(res, 405, 'text/plain', 'method not allowed', SECURITY_HEADERS);
      }
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
      await route.handler(req, res, { pathname, params: route.params });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      // Текст помилки — в лог, не клієнту: у ньому бувають uid датасорсів
      // і внутрішні хости.
      log.error(`http ${pathname}: ${redact(err.message)}`);
      if (!res.headersSent) respond(res, status, 'text/plain', 'error', SECURITY_HEADERS);
      else res.end();
    }
  });

  // Без цього обробника частина помилок протоколу спливає як uncaught.
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  return server;
}
