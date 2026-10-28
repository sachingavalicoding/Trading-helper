import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from './api.js';

/** The latest study of one kind ('options' or 'shares'), running it, and polling while it runs. */
export function useStudy(kind) {
  const [state, setState] = useState(null); // { status, result, note }
  const [error, setError] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await api(`/study/${kind}`);
      setState(d);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [kind]);

  useEffect(() => {
    load();
    return () => clearTimeout(timer.current);
  }, [load]);

  const running = state?.status?.state === 'running';
  useEffect(() => {
    if (!running) return undefined;
    timer.current = setTimeout(load, 2500);
    return () => clearTimeout(timer.current);
  }, [running, state, load]);

  const run = useCallback(
    async (days, extra = {}) => {
      try {
        await api(`/study/${kind}`, { method: 'POST', body: { days, ...extra } });
        await load();
      } catch (e) {
        toast.error(e.message || 'Could not start the study');
      }
    },
    [kind, load],
  );

  return { state, error, running, run };
}
