import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '../context/AuthContext.jsx';
import { useStartingBalance } from '../lib/useStartingBalance.js';
import { Disclaimer } from '../components/ui.jsx';

export default function AuthPage({ mode }) {
  const { user, login, register } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const { label } = useStartingBalance();
  const isRegister = mode === 'register';
  if (user) return <Navigate to="/" replace />;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      if (isRegister) await register(form.name, form.email, form.password);
      else await login(form.email, form.password);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  const input = 'field !py-3';
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <img src="/icon.svg" alt="" className="mx-auto mb-3 h-12 w-12" />
          <h1 className="text-2xl font-bold">Nifty Paper Trader</h1>
          <p className="mt-1 text-sm text-muted">Practise intraday trading on Nifty 50 with {label} of virtual money.</p>
        </div>
        <form onSubmit={submit} className="space-y-3">
          {isRegister && <input className={input} placeholder="Name" autoComplete="name" value={form.name} onChange={set('name')} required />}
          <input className={input} type="email" placeholder="Email" autoComplete="email" value={form.email} onChange={set('email')} required />
          <input
            className={input}
            type="password"
            placeholder={isRegister ? 'Password (8+ characters)' : 'Password'}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            minLength={isRegister ? 8 : undefined}
            value={form.password}
            onChange={set('password')}
            required
          />
          <button type="submit" disabled={busy} className="btn btn-primary btn-lg w-full">
            {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Log in'}
          </button>
        </form>
        <p className="mt-5 text-center text-sm text-muted">
          {isRegister ? 'Already have an account? ' : 'New here? '}
          <Link className="font-medium text-accent" to={isRegister ? '/login' : '/register'}>
            {isRegister ? 'Log in' : 'Create an account'}
          </Link>
        </p>
        <Disclaimer className="mt-10" />
      </div>
    </div>
  );
}
