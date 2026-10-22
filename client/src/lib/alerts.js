// Scanner alerts: always a toast in the app; a system notification too when the person turned
// alerts on and the tab is in the background. Browsers only deliver these while the page is open.
const KEY = 'scanner.alerts';

export const alertsSupported = () => typeof Notification !== 'undefined';

export function alertsOn() {
  try {
    return alertsSupported() && Notification.permission === 'granted' && localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Ask the browser for permission (must come from a tap) and remember the choice. */
export async function setAlerts(on) {
  if (!on) {
    try {
      localStorage.setItem(KEY, '0');
    } catch {
      /* storage blocked: the toggle just resets on reload */
    }
    return false;
  }
  if (!alertsSupported()) return false;
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  const granted = permission === 'granted';
  try {
    localStorage.setItem(KEY, granted ? '1' : '0');
  } catch {
    /* ignore */
  }
  return granted;
}

export function systemNotify(title, body, tag) {
  if (!alertsOn() || !document.hidden) return;
  try {
    new Notification(title, { body, tag, icon: '/icon.svg' });
  } catch {
    /* some mobile browsers only allow notifications from a service worker */
  }
}

const price = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export const entryText = (i) => `${i.side} ${i.symbol}: ${i.setup}. Entry ${price(i.entry)}, stop ${price(i.stopLoss)}, target ${price(i.target1)}`;
export const closedText = (i) => {
  const what = { TARGET_HIT: 'hit target 1', STOPPED: 'hit its stop loss', EXPIRED: 'expired' }[i.status] || i.status;
  return `${i.symbol} ${i.side} idea ${what}`;
};
export const planText = (p) => `Morning plan ready: ${p.count} stock${p.count === 1 ? '' : 's'} to watch${p.symbols?.length ? ` (${p.symbols.join(', ')})` : ''}`;
