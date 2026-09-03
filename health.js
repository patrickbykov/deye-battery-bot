// Health-check має відображати те, що бот справді робить роботу, а не те,
// що процес існує. Стара версія віддавала 200 безумовно з сервера, піднятого
// поза main() — тому мертвий бот пів року рапортував OK, а Fly не бачив причин
// його перезапускати.
export function healthStatus(lastSuccessAt, stalenessLimitMs, now) {
  if (lastSuccessAt === null || lastSuccessAt === undefined) {
    return { healthy: false, ageMs: null };
  }
  const ageMs = now - lastSuccessAt;
  return { healthy: ageMs < stalenessLimitMs, ageMs };
}
