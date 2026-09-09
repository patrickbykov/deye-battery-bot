import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPoint, toGridPoint, toLineProtocol, selectNewPoints } from './transform.js';

// Форма з docs/deye-cloud-api.md — реальна відповідь device/latest, обрізана.
function deviceData(overrides = {}) {
  return {
    deviceSn: '2000000001',
    deviceType: 'INVERTER',
    deviceState: 1,
    collectionTime: 1788455061,
    dataList: [
      { key: 'SOC', value: '98', unit: '%' },
      { key: 'BatteryVoltage', value: '53.93', unit: 'V' },
      { key: 'BatteryTotalCurrent', value: '1.06', unit: 'A' },
      { key: 'BatteryPower', value: '57', unit: 'W' },
      { key: 'Temperature- Battery', value: '26.00', unit: '℃' },
      { key: 'GridVoltageL1', value: '237.30', unit: 'V' },
      { key: 'GridVoltageL2', value: '234.00', unit: 'V' },
      { key: 'GridVoltageL3', value: '238.30', unit: 'V' },
      { key: 'GridCurrentL1', value: '0.87', unit: 'A' },
      { key: 'GridCurrentL2', value: '0.74', unit: 'A' },
      { key: 'GridCurrentL3', value: '0.76', unit: 'A' },
      { key: 'GridFrequency', value: '50.00', unit: 'Hz' },
      { key: 'TotalGridPower', value: '248', unit: 'W' },
    ],
    ...overrides,
  };
}

test('дістає SOC як число', () => {
  const point = toPoint(deviceData());
  assert.equal(point.fields.soc, 98);
});

test('дістає всі шість полів батареї, включно з ключем із пробілом', () => {
  const point = toPoint(deviceData());
  assert.deepEqual(point.fields, {
    soc: 98,
    voltage: 53.93,
    current: 1.06,
    power: 57,
    temperature: 26,
    state: 1,
  });
});

test('тегує точку серійником інвертора', () => {
  assert.equal(toPoint(deviceData()).inverter, '2000000001');
});

test('бере таймстемп виміру з collectionTime, а не поточний час', () => {
  assert.equal(toPoint(deviceData()).timestamp, 1788455061);
});

test('відхиляє SOC поза діапазоном 0..100', () => {
  const broken = deviceData();
  broken.dataList = broken.dataList.map(d => d.key === 'SOC' ? { ...d, value: '6500' } : d);
  assert.throws(() => toPoint(broken), /soc/);
});

test('відхиляє нечислове значення поля', () => {
  const broken = deviceData();
  broken.dataList = broken.dataList.map(d => d.key === 'BatteryVoltage' ? { ...d, value: 'n/a' } : d);
  assert.throws(() => toPoint(broken), /voltage/);
});

test('відхиляє точку без collectionTime', () => {
  assert.throws(() => toPoint(deviceData({ collectionTime: null })), /collectionTime/);
});

test('будує line protocol без суфікса i — усі поля float', () => {
  assert.equal(
    toLineProtocol([toPoint(deviceData())]),
    'battery,inverter=2000000001 soc=98,voltage=53.93,current=1.06,power=57,temperature=26,state=1 1788455061'
  );
});

test('розділяє кілька точок переводом рядка', () => {
  const lines = toLineProtocol([
    toPoint(deviceData()),
    toPoint(deviceData({ deviceSn: 'SN2', collectionTime: 1788455000 })),
  ]);
  assert.equal(lines.split('\n').length, 2);
  assert.match(lines.split('\n')[1], /^battery,inverter=SN2 /);
});

test('екранує спецсимволи в значенні тега', () => {
  const point = toPoint(deviceData({ deviceSn: 'Ліфт 3,корпус=A' }));
  assert.match(toLineProtocol([point]), /^battery,inverter=Ліфт\\ 3\\,корпус\\=A /);
});

test('на першому проході віддає всі точки', () => {
  const points = [toPoint(deviceData())];
  assert.deepEqual(selectNewPoints(points, new Map()), points);
});

test('відкидає точку з тим самим collectionTime, що вже записаний', () => {
  const point = toPoint(deviceData());
  const seen = new Map([['2000000001', 1788455061]]);
  assert.deepEqual(selectNewPoints([point], seen), []);
});

test('відкидає точку, давнішу за вже записану', () => {
  const point = toPoint(deviceData({ collectionTime: 1788455000 }));
  const seen = new Map([['2000000001', 1788455061]]);
  assert.deepEqual(selectNewPoints([point], seen), []);
});

test('бере максимум із трьох фаз, а не першу-ліпшу', () => {
  // Втрата однієї фази — це не блекаут: інвертор досі має мережу. Нулем має
  // стати максимум, тобто всі три разом.
  const point = toGridPoint(deviceData());
  assert.equal(point.fields.voltage, 238.3);
  assert.equal(point.fields.frequency, 50);
  assert.equal(point.fields.power, 248);
});

test('зникнення мережі дає нуль напруги', () => {
  const dead = deviceData();
  dead.dataList = dead.dataList.map(d =>
    d.key.startsWith('GridVoltage') ? { ...d, value: '0.00' } : d);
  assert.equal(toGridPoint(dead).fields.voltage, 0);
});

test('струм мережі — максимум по фазах', () => {
  assert.equal(toGridPoint(deviceData()).fields.current, 0.87);
});

test('відʼємний струм при експорті читається за модулем, а не як менший', () => {
  // Знак означає напрямок; нам важлива лише наявність струму взагалі.
  const exporting = deviceData();
  exporting.dataList = exporting.dataList.map(d =>
    d.key === 'GridCurrentL1' ? { ...d, value: '-3.20' } : d);
  assert.equal(toGridPoint(exporting).fields.current, 3.2);
});

test('нульовий струм на всіх фазах лишається нулем, а не зникає', () => {
  // Це і є підпис відʼєднання від мережі — поле мусить доїхати як 0.
  const detached = deviceData();
  detached.dataList = detached.dataList.map(d =>
    d.key.startsWith('GridCurrent') ? { ...d, value: '0.00' } : d);
  assert.equal(toGridPoint(detached).fields.current, 0);
});

test('без ключів струму поля current немає — вигаданий нуль означав би відʼєднання', () => {
  const noCurrent = deviceData();
  noCurrent.dataList = noCurrent.dataList.filter(d => !d.key.startsWith('GridCurrent'));
  const fields = toGridPoint(noCurrent).fields;
  assert.equal('current' in fields, false);
  assert.equal(fields.voltage, 238.3);
});

test('обʼєкт без даних мережі не дає точки', () => {
  // Не всі пристрої віддають ці ключі; вигадувати нулі означало б
  // повідомити про блекаут там, де його немає.
  const noGrid = deviceData();
  noGrid.dataList = noGrid.dataList.filter(d => !d.key.startsWith('Grid') && d.key !== 'TotalGridPower');
  assert.equal(toGridPoint(noGrid), null);
});

test('точка мережі має свій вимір і той самий тег', () => {
  const point = toGridPoint(deviceData());
  assert.equal(point.measurement, 'grid');
  assert.equal(point.inverter, '2000000001');
  assert.equal(point.timestamp, 1788455061);
});

test('line protocol пише обидва виміри в одному запиті', () => {
  const lines = toLineProtocol([toPoint(deviceData()), toGridPoint(deviceData())]).split('\n');
  assert.match(lines[0], /^battery,inverter=/);
  assert.match(lines[1], /^grid,inverter=/);
  assert.match(lines[1], /voltage=238\.3/);
});

test('дедуп не губить другу точку того самого пристрою', () => {
  // Обидві точки мають однаковий inverter і timestamp — наївний дедуп за
  // ключем інвертора викинув би одну з них.
  const points = [toPoint(deviceData()), toGridPoint(deviceData())];
  assert.equal(selectNewPoints(points, new Map()).length, 2);
});
