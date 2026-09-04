import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from './collector.js';

function device(sn, collectionTime, socValue = '98') {
  return {
    deviceSn: sn, deviceType: 'INVERTER', deviceState: 1, collectionTime,
    dataList: [
      { key: 'SOC', value: socValue },
      { key: 'BatteryVoltage', value: '53.93' },
      { key: 'BatteryTotalCurrent', value: '1.06' },
      { key: 'BatteryPower', value: '57' },
      { key: 'Temperature- Battery', value: '26.00' },
    ],
  };
}

function harness(devicesPerCycle) {
  const written = [];
  const warnings = [];
  const collector = createCollector({
    deye: {
      listInverterSns: async () => ['SN1', 'SN2'],
      getLatest: async () => devicesPerCycle.shift() ?? [],
    },
    influx: { write: async lp => written.push(lp) },
    log: { info() {}, warn: (...a) => warnings.push(a.join(' ')), error() {} },
  });
  return { collector, written, warnings };
}

test('пише отримані з Deye точки в line protocol', async () => {
  const { collector, written } = harness([[device('SN1', 1788455061)]]);
  await collector.runCycle();

  assert.equal(written.length, 1);
  assert.match(written[0], /^battery,inverter=SN1 soc=98,.* 1788455061$/);
});

test('не пише вдруге ті самі дані, якщо collectionTime не змінився', async () => {
  const { collector, written } = harness([
    [device('SN1', 1788455061)],
    [device('SN1', 1788455061)],
  ]);
  await collector.runCycle();
  await collector.runCycle();

  assert.equal(written.length, 1);
});

test('пише знову, коли з являється свіжий вимір', async () => {
  const { collector, written } = harness([
    [device('SN1', 1788455061)],
    [device('SN1', 1788455999)],
  ]);
  await collector.runCycle();
  await collector.runCycle();

  assert.equal(written.length, 2);
});

test('одна бита точка не блокує решту пристроїв', async () => {
  const { collector, written, warnings } = harness([[
    device('SN1', 1788455061, '6500'),  // SOC поза межами
    device('SN2', 1788455061),
  ]]);
  await collector.runCycle();

  assert.equal(written.length, 1);
  assert.match(written[0], /inverter=SN2/);
  assert.match(warnings.join('\n'), /SN1/);
});

test('не звертається до Influx, коли писати нічого', async () => {
  const { collector, written } = harness([[]]);
  await collector.runCycle();
  assert.deepEqual(written, []);
});

function withGrid(sn, collectionTime, over = {}) {
  const d = device(sn, collectionTime);
  d.dataList = [...d.dataList,
    { key: 'GridVoltageL1', value: over.v ?? '237.30' },
    { key: 'GridVoltageL2', value: over.v ?? '234.00' },
    { key: 'GridVoltageL3', value: over.v ?? '238.30' },
    { key: 'GridFrequency', value: '50.00' },
    { key: 'TotalGridPower', value: '248' },
  ];
  return d;
}

test('пише обидва виміри — батарею і мережу', async () => {
  const { collector, written } = harness([[withGrid('SN1', 1788455061)]]);
  await collector.runCycle();
  assert.match(written[0], /battery,inverter=SN1/);
  assert.match(written[0], /grid,inverter=SN1/);
});

test('бита телеметрія батареї не засліплює щодо мережі', async () => {
  // Блекаут — критичніший сигнал за SOC. Якщо батарейні поля зіпсуті, дані
  // мережі все одно мають дійти.
  const broken = withGrid('SN1', 1788455061);
  broken.dataList = broken.dataList.map(d => d.key === 'SOC' ? { ...d, value: '6500' } : d);

  const { collector, written, warnings } = harness([[broken]]);
  await collector.runCycle();

  assert.match(written.join(''), /grid,inverter=SN1/);
  assert.doesNotMatch(written.join(''), /battery,inverter=SN1/);
  assert.match(warnings.join(' '), /SN1/);
});
