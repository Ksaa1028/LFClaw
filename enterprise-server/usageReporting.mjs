const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;

export const summarizeUsageEvents = events => ({
  callCount: Array.isArray(events) ? events.length : 0,
  creditsUsed: Number((Array.isArray(events) ? events : [])
    .reduce((total, event) => total + number(event?.credits), 0)
    .toFixed(4)),
});

export const buildUsageReport = (events, options = {}) => {
  const employeeId = String(options.employeeId || '').trim();
  const modelId = String(options.modelId || '').trim();
  const requestedPage = Math.max(1, Math.trunc(number(options.page) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(number(options.pageSize) || 10)));
  const filteredEvents = (Array.isArray(events) ? events : []).filter(event => (
    (!employeeId || event?.employeeId === employeeId)
    && (!modelId || event?.modelId === modelId)
  ));
  const grouped = new Map();
  for (const event of filteredEvents) {
    const day = String(event?.createdAt || '').slice(0, 10) || '-';
    const eventEmployeeId = String(event?.employeeId || '');
    const eventModelId = String(event?.modelId || '');
    const key = `${day}|${eventEmployeeId}|${eventModelId}`;
    const row = grouped.get(key) || {
      day,
      employeeId: eventEmployeeId,
      modelId: eventModelId,
      tokens: 0,
      credits: 0,
    };
    row.tokens += number(event?.inputTokens)
      + number(event?.outputTokens)
      + number(event?.cacheWriteTokens)
      + number(event?.cacheReadTokens);
    row.credits += number(event?.credits);
    grouped.set(key, row);
  }
  const allRows = [...grouped.values()]
    .map(row => ({ ...row, credits: Number(row.credits.toFixed(4)) }))
    .sort((left, right) => (
      String(right.day).localeCompare(String(left.day))
      || String(left.employeeId).localeCompare(String(right.employeeId))
      || String(left.modelId).localeCompare(String(right.modelId))
    ));
  const totalRows = allRows.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const start = (page - 1) * pageSize;
  return {
    ...summarizeUsageEvents(filteredEvents),
    totalRows,
    page,
    pageCount,
    pageSize,
    rows: allRows.slice(start, start + pageSize),
  };
};
