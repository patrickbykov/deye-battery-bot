import { scrypt, timingSafeEqual, randomBytes, createHmac, hkdfSync } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const scryptAsync = promisify(scrypt);

// N = 16384 — стеля без підняття maxmem. Node рахує 128·N·r ≈ 16.8 MB, а
// дефолт maxmem 32 MB; N = 32768 дав би 33.5 MB і виняток у рантаймі. На
// машині з 256 MB піднімати maxmem — погана ідея.
const COST = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;

export function parsePasswordHash(value) {
  const parts = String(value ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;

  const [, N, r, p, salt, hash] = parts;
  const cost = { N: Number(N), r: Number(r), p: Number(p) };
  if (!Number.isInteger(cost.N) || cost.N < 1024 || cost.N > 16384) return null;
  if (!Number.isInteger(cost.r) || !Number.isInteger(cost.p)) return null;

  return { ...cost, salt: Buffer.from(salt, 'base64url'), hash: Buffer.from(hash, 'base64url') };
}

export async function hashPassword(password, salt = randomBytes(16)) {
  const derived = await scryptAsync(String(password).normalize('NFKC'), salt, KEY_LENGTH, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password, hashString) {
  const parsed = parsePasswordHash(hashString);
  if (!parsed) return false;   // немає або битий секрет → не пускаємо нікого

  const derived = await scryptAsync(
    String(password).normalize('NFKC'), parsed.salt, parsed.hash.length, parsed
  );
  return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
}

// Ключі виводимо з самого хеша пароля: окремий секрет не потрібен, а зміна
// пароля автоматично розлогінює всі сесії — саме те, чого хочеш, міняючи його.
export function deriveKeys(passwordHash) {
  const root = Buffer.from(String(passwordHash ?? ''), 'utf8');
  const salt = Buffer.from('deye-admin');
  return {
    session: Buffer.from(hkdfSync('sha256', root, salt, 'deye/session/v1', 32)),
    csrf: Buffer.from(hkdfSync('sha256', root, salt, 'deye/csrf/v1', 32)),
  };
}

const sign = (payload, key) => createHmac('sha256', key).update(payload).digest();

export function signSession(payload, key) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, key).toString('base64url')}`;
}

export function verifySession(value, key, nowMs) {
  const text = String(value ?? '');
  const dot = text.lastIndexOf('.');
  if (dot < 1) return null;

  const encoded = text.slice(0, dot);
  const signature = Buffer.from(text.slice(dot + 1), 'base64url');
  const expected = sign(encoded, key);
  // Довжину звіряємо окремо: timingSafeEqual кидає на різній, і підроблена
  // cookie давала б 500 замість 401.
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload?.sid !== 'string' || typeof payload?.exp !== 'number') return null;
  if (payload.exp * 1000 <= nowMs) return null;
  return payload;
}

// Атакувальник не читає cookie (HttpOnly) → не знає sid → не порахує токен.
export const csrfToken = (sid, key) => sign(String(sid), key).toString('base64url');

export function csrfValid(sid, token, key) {
  const got = Buffer.from(String(token ?? ''), 'base64url');
  const want = sign(String(sid), key);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function throttleDecision(state, key, nowMs, {
  windowMs = 15 * 60_000, perKeyLimit = 5, globalLimit = 20,
} = {}) {
  state.attempts ??= new Map();
  for (const [k, times] of state.attempts) {
    const fresh = times.filter(t => nowMs - t < windowMs);
    if (fresh.length === 0) state.attempts.delete(k); else state.attempts.set(k, fresh);
  }

  const perKey = state.attempts.get(key) ?? [];
  const total = [...state.attempts.values()].reduce((sum, t) => sum + t.length, 0);
  if (perKey.length >= perKeyLimit || total >= globalLimit) {
    return { allowed: false, retryAfterSec: Math.ceil(windowMs / 1000) };
  }

  state.attempts.set(key, [...perKey, nowMs]);
  return { allowed: true };
}

// Генерація хеша: `node admin-auth.js` і пароль у stdin. Не аргументом —
// той осідає в history і видно в `ps`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const password = Buffer.concat(chunks).toString('utf8').trim();
  if (!password) {
    console.error('Порожній пароль. Використання: echo -n "пароль" | node admin-auth.js');
    process.exit(1);
  }
  console.log(await hashPassword(password));
}
