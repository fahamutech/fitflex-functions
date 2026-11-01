// Tanzania time (Africa/Dar_es_Salaam, UTC+3, no daylight saving) for messages. Extracted unchanged from
// partner-notifier so the web check-in alert shows the same format.
// English: dd/mm/yyyy HH:mm (24-hour). Swahili (i18n review 2026-10-29): dd/mm/yyyy,
// 12-hour clock and the time of day — "31/10/2026 6:00 jioni". [SW review] period words:
// 05–11 asubuhi, 12–15 mchana, 16–18 jioni, 19–04 usiku.

export const eatParts = (v) => {
  const t = new Date(v);
  if (Number.isNaN(t.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Dar_es_Salaam', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(t).map(p => [p.type, p.value]));
  return { date: `${parts.day}/${parts.month}/${parts.year}`, hour: Number(parts.hour), minute: parts.minute };
};

export const eatDate = (v, locale = 'en') => {
  const p = eatParts(v);
  if (!p) return '';
  if (locale !== 'sw') return `${p.date} ${String(p.hour).padStart(2, '0')}:${p.minute}`;
  const h12 = p.hour % 12 || 12;
  const period = p.hour >= 5 && p.hour <= 11 ? 'asubuhi' : p.hour >= 12 && p.hour <= 15 ? 'mchana' : p.hour >= 16 && p.hour <= 18 ? 'jioni' : 'usiku';
  return `${p.date} ${h12}:${p.minute} ${period}`;
};
