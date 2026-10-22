// NSE cash market timings, all in IST (UTC+05:30, no daylight saving).
const IST_OFFSET_MIN = 330;
export const OPEN_MIN = 9 * 60 + 15; // 09:15
export const CLOSE_MIN = 15 * 60 + 30; // 15:30
export const SQUARE_OFF_MIN = 15 * 60 + 15; // 15:15 MIS auto square-off

// Returns IST wall-clock parts for a Date, using UTC getters on a shifted timestamp.
export function istParts(date = new Date()) {
  const d = new Date(date.getTime() + IST_OFFSET_MIN * 60000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return {
    dateKey: `${y}-${m}-${day}`,
    weekday: d.getUTCDay(), // 0 = Sunday
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    seconds: d.getUTCSeconds(),
  };
}

// The UTC Date at which a given IST minute-of-day occurs on the IST date of `ref`.
export function istTimeOn(ref, minuteOfDay) {
  const { dateKey } = istParts(ref);
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, minuteOfDay) - IST_OFFSET_MIN * 60000);
}

export function isTradingDay(date = new Date(), holidays = []) {
  const { weekday, dateKey } = istParts(date);
  return weekday !== 0 && weekday !== 6 && !holidays.includes(dateKey);
}

export function getMarketStatus(date = new Date(), holidays = []) {
  const { minutes, dateKey } = istParts(date);
  const tradingDay = isTradingDay(date, holidays);
  let phase;
  if (!tradingDay) phase = holidays.includes(dateKey) ? 'HOLIDAY' : 'WEEKEND';
  else if (minutes < OPEN_MIN) phase = 'PRE_OPEN';
  else if (minutes < CLOSE_MIN) phase = 'OPEN';
  else phase = 'CLOSED';

  return {
    isOpen: phase === 'OPEN',
    phase,
    tradingDay,
    istDate: dateKey,
    afterSquareOff: tradingDay && minutes >= SQUARE_OFF_MIN,
    opensAt: '09:15 IST',
    closesAt: '15:30 IST',
    squareOffAt: '15:15 IST',
  };
}
