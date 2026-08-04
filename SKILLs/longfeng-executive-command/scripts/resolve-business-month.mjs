const value = process.argv[2];

if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value || '')) {
  throw new Error('Usage: node resolve-business-month.mjs <yyyy-MM>');
}

const [year, month] = value.split('-').map(Number);
const previous = new Date(Date.UTC(year, month - 2, 1));
const previousYear = previous.getUTCFullYear();
const previousMonth = String(previous.getUTCMonth() + 1).padStart(2, '0');
const targetMonth = String(month).padStart(2, '0');

process.stdout.write(`${JSON.stringify({
  businessMonth: value,
  startDate: `${previousYear}-${previousMonth}-26`,
  endDate: `${year}-${targetMonth}-25`,
  label: `${year}年${month}月经营月`,
})}\n`);
