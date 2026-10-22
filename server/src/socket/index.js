import { Server } from 'socket.io';
import { verifyToken } from '../middleware/auth.js';
import { ALL_SYMBOLS, isIndex } from '../market/instruments.js';

const THROTTLE_MS = 250; // at most 4 updates per symbol per second to each client
const MAX_SUBSCRIPTIONS = 80;
const valid = new Set(ALL_SYMBOLS);

/**
 * Relays provider ticks to browsers. Rooms:
 *   sym:<SYMBOL>    ticks without depth (watchlist rows, positions)
 *   depth:<SYMBOL>  full ticks with 5-level depth (stock detail page)
 *   indices         index ticks, joined automatically
 *   user:<id>       order/fill/square-off notifications for one user
 */
export function attachSocket(httpServer, { market, engine, config }) {
  const io = new Server(httpServer, { cors: { origin: config.clientOrigin, credentials: true } });

  io.use((socket, next) => {
    try {
      socket.data.userId = verifyToken(socket.handshake.auth?.token, config.jwtSecret);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`);
    socket.join('indices');
    socket.emit('market:status', market.status());

    const roomsFor = (symbols, withDepth) =>
      (Array.isArray(symbols) ? symbols : [symbols])
        .map((s) => String(s).toUpperCase())
        .filter((s) => valid.has(s))
        .map((s) => `${withDepth ? 'depth' : 'sym'}:${s}`);

    socket.on('subscribe', (payload, ack) => {
      // Clients send arbitrary data; a null/non-object payload must not throw out of the handler.
      const { symbols = [], depth = false } = payload && typeof payload === 'object' ? payload : {};
      if (typeof ack !== 'function') ack = undefined;
      const rooms = roomsFor(symbols, depth);
      if (socket.rooms.size + rooms.length > MAX_SUBSCRIPTIONS + 3) return ack?.({ ok: false, error: 'Too many subscriptions' });
      socket.join(rooms);
      // Send the latest known values right away so the UI does not wait for the next tick.
      for (const room of rooms) {
        const tick = market.getTick(room.split(':')[1]);
        if (tick) socket.emit('tick', room.startsWith('depth:') ? tick : stripDepth(tick));
      }
      ack?.({ ok: true });
    });

    socket.on('unsubscribe', (payload) => {
      const { symbols = [], depth = false } = payload && typeof payload === 'object' ? payload : {};
      for (const room of roomsFor(symbols, depth)) socket.leave(room);
    });
  });

  // Throttle: remember the newest tick per symbol and flush on a timer.
  const pending = new Map();
  market.on('tick', (tick) => pending.set(tick.symbol, tick));
  const flush = setInterval(() => {
    for (const tick of pending.values()) {
      if (isIndex(tick.symbol)) io.to('indices').emit('tick', tick);
      else {
        io.to(`sym:${tick.symbol}`).except(`depth:${tick.symbol}`).emit('tick', stripDepth(tick));
        io.to(`depth:${tick.symbol}`).emit('tick', tick);
      }
    }
    pending.clear();
  }, THROTTLE_MS);
  flush.unref?.();

  market.on('status', (status) => io.emit('market:status', status));
  const statusTimer = setInterval(() => io.emit('market:status', market.status()), 30000);
  statusTimer.unref?.();

  engine.on('update', (evt) => io.to(`user:${evt.userId}`).emit('order:update', evt));

  io.closeAll = () => {
    clearInterval(flush);
    clearInterval(statusTimer);
    io.close();
  };
  return io;
}

function stripDepth(tick) {
  const { depth: _d, ...rest } = tick;
  return rest;
}
