// Angel One SmartAPI WebSocket 2.0 binary packets (little endian, prices in paise).
// Layout written from Angel One's published packet table; see the note in AngelOneProvider.js
// about checking it against a live feed with `npm run angel:check`.

export const MODE = { LTP: 1, QUOTE: 2, SNAP_QUOTE: 3 };
const SNAP_MIN = 147; // header and quote fields, before the five-level book
const BOOK_START = 147;
const BOOK_RECORD = 20;

const paise = (n) => Number(n) / 100;

/**
 * Decode one binary frame into plain numbers (prices in rupees). Returns null for frames that
 * are too short to be a quote. Depth is only present in SNAP_QUOTE (mode 3).
 */
export function parsePacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 51) return null;
  const mode = buf.readUInt8(0);
  if (mode < MODE.LTP || mode > MODE.SNAP_QUOTE) return null;
  const exchangeType = buf.readUInt8(1);
  const nul = buf.indexOf(0, 2);
  const token = buf.toString('latin1', 2, nul === -1 || nul > 27 ? 27 : nul);
  const pkt = {
    mode,
    exchangeType,
    token,
    exchangeTs: Number(buf.readBigInt64LE(35)), // ms epoch
    ltp: paise(buf.readInt32LE(43)),
  };
  if (mode >= MODE.QUOTE && buf.length >= 119) {
    Object.assign(pkt, {
      lastQty: Number(buf.readBigInt64LE(47)),
      atp: paise(buf.readBigInt64LE(55)),
      volume: Number(buf.readBigInt64LE(63)),
      totalBuyQty: buf.readDoubleLE(71),
      totalSellQty: buf.readDoubleLE(79),
      open: paise(buf.readBigInt64LE(87)),
      high: paise(buf.readBigInt64LE(95)),
      low: paise(buf.readBigInt64LE(103)),
      prevClose: paise(buf.readBigInt64LE(111)),
    });
  }
  if (mode === MODE.SNAP_QUOTE && buf.length >= BOOK_START + 10 * BOOK_RECORD) {
    const bids = [];
    const asks = [];
    for (let i = 0; i < 10; i++) {
      const at = BOOK_START + i * BOOK_RECORD;
      const rec = { price: paise(buf.readBigInt64LE(at + 10)), qty: Number(buf.readBigInt64LE(at + 2)), orders: buf.readInt16LE(at + 18) };
      (buf.readInt16LE(at) === 1 ? bids : asks).push(rec);
    }
    pkt.depth = { bids, asks };
  }
  return pkt;
}

/** Cheap checks that catch a wrong layout (for example a shifted field) instead of showing bad prices. */
export function looksSane(pkt) {
  if (!pkt || !(pkt.ltp > 0)) return false;
  if (pkt.high == null) return true;
  return pkt.high >= pkt.low && pkt.ltp <= pkt.high * 1.001 && pkt.ltp >= pkt.low * 0.999 && pkt.volume >= 0;
}

/** Build a SNAP_QUOTE packet. Used by tests and by `angel:check --selftest`; mirrors parsePacket. */
export function buildPacket({ token, exchangeType = 1, mode = MODE.SNAP_QUOTE, ltp, open = ltp, high = ltp, low = ltp, prevClose = ltp, volume = 0, atp = ltp, totalBuyQty = 0, totalSellQty = 0, ts = Date.now(), bids = [], asks = [] }) {
  const buf = Buffer.alloc(mode === MODE.SNAP_QUOTE ? 379 : mode === MODE.QUOTE ? 123 : 51);
  buf.writeUInt8(mode, 0);
  buf.writeUInt8(exchangeType, 1);
  buf.write(String(token), 2, 'latin1');
  buf.writeBigInt64LE(BigInt(ts), 35);
  buf.writeInt32LE(Math.round(ltp * 100), 43);
  if (mode >= MODE.QUOTE) {
    buf.writeBigInt64LE(0n, 47);
    buf.writeBigInt64LE(BigInt(Math.round(atp * 100)), 55);
    buf.writeBigInt64LE(BigInt(volume), 63);
    buf.writeDoubleLE(totalBuyQty, 71);
    buf.writeDoubleLE(totalSellQty, 79);
    buf.writeBigInt64LE(BigInt(Math.round(open * 100)), 87);
    buf.writeBigInt64LE(BigInt(Math.round(high * 100)), 95);
    buf.writeBigInt64LE(BigInt(Math.round(low * 100)), 103);
    buf.writeBigInt64LE(BigInt(Math.round(prevClose * 100)), 111);
  }
  if (mode === MODE.SNAP_QUOTE) {
    [...bids.map((b) => [1, b]), ...asks.map((a) => [0, a])].forEach(([flag, r], i) => {
      const at = BOOK_START + i * BOOK_RECORD;
      buf.writeInt16LE(flag, at);
      buf.writeBigInt64LE(BigInt(r.qty), at + 2);
      buf.writeBigInt64LE(BigInt(Math.round(r.price * 100)), at + 10);
      buf.writeInt16LE(r.orders ?? 1, at + 18);
    });
  }
  return buf;
}
