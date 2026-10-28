// Calendar-day helpers on 'YYYY-MM-DD' strings (IST dates, no time zone maths needed).
const DAY_MS = 86400000;
const ms = (day) => Date.parse(`${day}T00:00:00Z`);

export const addDays = (day, n) => new Date(ms(day) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from, to) => Math.round((ms(to) - ms(from)) / DAY_MS);
export const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
