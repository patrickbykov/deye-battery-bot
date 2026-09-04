import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webhookAuthorized, parseGrafanaWebhook, dedupKey } from './webhook-grafana.js';

test('пропускає лише правильний Bearer', () => {
  assert.equal(webhookAuthorized('Bearer secret123', 'secret123'), true);
  assert.equal(webhookAuthorized('Bearer wrong', 'secret123'), false);
  assert.equal(webhookAuthorized('secret123', 'secret123'), false, 'без схеми — не пускати');
  assert.equal(webhookAuthorized('Basic secret123', 'secret123'), false);
  assert.equal(webhookAuthorized(undefined, 'secret123'), false);
});

test('незаданий секрет НЕ відкриває ендпойнт', () => {
  // Інакше забутий GRAFANA_WEBHOOK_TOKEN перетворює множник повідомлень
  // у відкритий для всіх.
  assert.equal(webhookAuthorized('Bearer anything', undefined), false);
  assert.equal(webhookAuthorized('Bearer anything', ''), false);
});

test('токени різної довжини не кидають винятку', () => {
  // timingSafeEqual кидає на різній довжині, і сам виняток злив би довжину.
  assert.equal(webhookAuthorized('Bearer x', 'значно-довший-токен'), false);
});

const alert = (over = {}) => ({
  status: 'firing',
  labels: { alertname: '🔋 Заряд батареї нижче 20%', grafana_folder: 'Deye Alerts', inverter: 'INV1' },
  annotations: { summary: 'Заряд нижче 20%', description: 'Батарея майже розряджена.', resolved: 'заряд відновився' },
  startsAt: '2026-09-04T06:00:00Z',
  fingerprint: 'abc123',
  ...over,
});

test('розбирає firing з міткою інвертора', () => {
  const [a] = parseGrafanaWebhook({ alerts: [alert()] });
  assert.equal(a.status, 'firing');
  assert.equal(a.inverterId, 'INV1');
  assert.equal(a.summary, 'Заряд нижче 20%');
});

test('розбирає resolved', () => {
  const [a] = parseGrafanaWebhook({ alerts: [alert({ status: 'resolved' })] });
  assert.equal(a.status, 'resolved');
  assert.equal(a.resolved, 'заряд відновився');
});

test('алерт без мітки інвертора → inverterId null, а не виняток', () => {
  // Правило застою робить group() — теги схлопуються, мітки не буде.
  const [a] = parseGrafanaWebhook({ alerts: [alert({ labels: { alertname: 'Немає даних' } })] });
  assert.equal(a.inverterId, null);
});

test('кілька алертів у батчі розбираються окремо', () => {
  const parsed = parseGrafanaWebhook({ alerts: [alert(), alert({ labels: { inverter: 'INV2' } })] });
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map(a => a.inverterId), ['INV1', 'INV2']);
});

test('битий payload не валить розбір', () => {
  assert.deepEqual(parseGrafanaWebhook({}), []);
  assert.deepEqual(parseGrafanaWebhook({ alerts: 'ні' }), []);
  assert.deepEqual(parseGrafanaWebhook(null), []);
});

test('відсутній fingerprint не схлопує різні алерти в один ключ', () => {
  // У ручному тесті з UI Grafana fingerprint може бути відсутній.
  const parsed = parseGrafanaWebhook({ alerts: [
    alert({ fingerprint: undefined, labels: { alertname: 'A', inverter: 'INV1' } }),
    alert({ fingerprint: undefined, labels: { alertname: 'B', inverter: 'INV2' } }),
  ] });
  assert.notEqual(dedupKey(parsed[0]), dedupKey(parsed[1]));
});

test('наддовгий опис обрізається — інакше Telegram відхилить усе', () => {
  const [a] = parseGrafanaWebhook({ alerts: [alert({
    annotations: { summary: 'x', description: 'д'.repeat(5000) },
  })] });
  assert.ok(a.description.length <= 900);
});

test('dedupKey розрізняє firing і resolved', () => {
  const [f] = parseGrafanaWebhook({ alerts: [alert()] });
  const [r] = parseGrafanaWebhook({ alerts: [alert({ status: 'resolved' })] });
  assert.notEqual(dedupKey(f), dedupKey(r));
});
