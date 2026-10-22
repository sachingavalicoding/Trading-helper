// Rupee amounts are rounded to paise to avoid floating point drift in balances.
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// NSE equity tick size is ₹0.05 for most Nifty 50 stocks.
export const TICK_SIZE = 0.05;
export const roundToTick = (price, tick = TICK_SIZE) => round2(Math.round(price / tick) * tick);
