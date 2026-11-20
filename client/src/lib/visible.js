/**
 * Runs `fn` every `ms` while the app is on screen. When the phone locks or the app goes to the background the timer skips (no
 * network or work for a screen nobody sees), and on coming back `fn` runs once at once if a turn was missed, so the data is fresh.
 * Returns the cleanup for useEffect. Display only: the server's trading never depends on this.
 */
export function everyVisible(fn, ms) {
  let missed = false;
  const id = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) missed = true;
    else fn();
  }, ms);
  const onShow = () => {
    if (!document.hidden && missed) {
      missed = false;
      fn();
    }
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onShow);
  return () => {
    clearInterval(id);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onShow);
  };
}
