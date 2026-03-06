export function fmt(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return Number(value).toFixed(decimals);
}

export function renderSocBar(soc) {
  if (soc === null || soc === undefined) return '';
  const filled = Math.round(soc / 10);
  return '[' + '█'.repeat(filled) + '░'.repeat(10 - filled) + ']';
}

export function formatKyivTime(time) {
  if (!time) return 'N/A';
  return new Date(time).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
}

export function parseGrafanaFields(frames) {
  const schema = frames[0].schema?.fields || [];
  const values = frames[0].data?.values || [];

  const fields = {};
  schema.forEach((field, i) => {
    fields[field.name] = values[i]?.[values[i].length - 1];
  });
  return fields;
}
