import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api, API_BASE } from '../lib/api.js';
import { setTick, clearTicks } from '../lib/tickStore.js';
import { entryText, closedText, planText, systemNotify } from '../lib/alerts.js';
import { useAuth } from './AuthContext.jsx';

const MarketContext = createContext(null);

/**
 * Owns the Socket.IO connection, the instrument list, market/feed status, and a
 * `version` counter that bumps on every order event so pages know to refetch.
 */
export function MarketProvider({ children }) {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [instruments, setInstruments] = useState(null);
  const [status, setStatus] = useState(null);
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState(0);
  const socketRef = useRef(null);
  const symbolsRef = useRef([]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!token) return undefined;
    let alive = true;
    api('/market/snapshot')
      .then((snap) => {
        if (!alive) return;
        for (const s of [...snap.stocks, ...snap.indices]) if (s.tick) setTick(s.tick);
        setInstruments({ stocks: snap.stocks.map(({ symbol, name, sector }) => ({ symbol, name, sector })), indices: snap.indices.map(({ symbol, name }) => ({ symbol, name })) });
        setStatus({ market: snap.market, feed: snap.feed });
        symbolsRef.current = snap.stocks.map((s) => s.symbol);
        setReady(true);
        socketRef.current?.emit('subscribe', { symbols: symbolsRef.current });
      })
      .catch((err) => toast.error(err.message));

    const socket = io(API_BASE || undefined, { auth: { token }, transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('connect', () => {
      setConnected(true);
      if (symbolsRef.current.length) socket.emit('subscribe', { symbols: symbolsRef.current });
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('tick', setTick);
    socket.on('market:status', setStatus);
    socket.on('order:update', (evt) => {
      refresh();
      if (evt.kind === 'fill') toast.success(evt.message);
      else if (evt.kind === 'squareoff') toast.info(evt.message);
      else if (evt.order?.status === 'REJECTED') toast.error(evt.message || 'Order rejected');
    });

    socket.on('scanner:entry', (idea) => {
      toast.info(`New idea: ${entryText(idea)}`, { duration: 10_000, action: { label: 'View', onClick: () => navigate('/scanner') } });
      systemNotify('New scanner idea', entryText(idea), `entry-${idea.symbol}`);
    });
    socket.on('scanner:closed', (idea) => {
      toast(closedText(idea));
      systemNotify('Scanner idea closed', closedText(idea), `closed-${idea.symbol}`);
    });
    socket.on('scanner:plan', (plan) => {
      toast.info(planText(plan), { duration: 10_000, action: { label: 'View', onClick: () => navigate('/scanner') } });
      systemNotify('Morning plan', planText(plan), 'plan');
    });

    return () => {
      alive = false;
      socket.close();
      socketRef.current = null;
      clearTicks();
      setReady(false);
    };
  }, [token, refresh, navigate]);

  const subscribeDepth = useCallback((symbol) => {
    const s = socketRef.current;
    s?.emit('subscribe', { symbols: [symbol], depth: true });
    return () => s?.emit('unsubscribe', { symbols: [symbol], depth: true });
  }, []);

  const value = useMemo(
    () => ({ instruments, status, connected, ready, version, refresh, subscribeDepth }),
    [instruments, status, connected, ready, version, refresh, subscribeDepth],
  );
  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}

export const useMarket = () => useContext(MarketContext);
