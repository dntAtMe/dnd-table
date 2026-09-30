import type { CampaignSummary, ServerConfig, User } from '@dnd/protocol';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

function AuthForm() {
  const { setUser } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [config, setConfig] = useState<ServerConfig>();
  const [form, setForm] = useState({ username: '', displayName: '', password: '', signupCode: '' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<ServerConfig>('/api/config').then(setConfig).catch(() => {});
  }, []);

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body =
        mode === 'login'
          ? { username: form.username, password: form.password }
          : { ...form, signupCode: form.signupCode || undefined };
      const res = await api<{ user: User }>(`/api/auth/${mode}`, { body });
      setUser(res.user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="brand brand--lg">
        <img src="/favicon.svg" alt="" width={40} height={40} />
        <h1>dnd-table</h1>
      </div>
      <p className="auth__tagline">A shared table for your D&amp;D group.</p>
      <div className="card">
        <div className="segmented segmented--full" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'is-active' : ''} onClick={() => setMode('login')}>
            Sign in
          </button>
          <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'is-active' : ''} onClick={() => setMode('register')}>
            Create account
          </button>
        </div>
        <form className="stack" onSubmit={submit}>
          <label>
            Username
            <input {...field('username')} autoComplete="username" autoCapitalize="none" required />
          </label>
          {mode === 'register' && (
            <label>
              Display name
              <input {...field('displayName')} placeholder="What the table calls you" required maxLength={40} />
            </label>
          )}
          <label>
            Password
            <input
              {...field('password')}
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'register' ? 8 : undefined}
              required
            />
          </label>
          {mode === 'register' && config?.signupCodeRequired && (
            <label>
              Signup code
              <input {...field('signupCode')} placeholder="Ask your GM" required />
            </label>
          )}
          {error && <p className="form-error">{error}</p>}
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </div>
      <Link className="table-link" to="/table">
        Use this device as a table screen →
      </Link>
    </div>
  );
}

function Campaigns({ user }: { user: User }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>();
  const [name, setName] = useState('');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<CampaignSummary[]>('/api/campaigns').then(setCampaigns).catch((err) => setError(errorMessage(err)));
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { id } = await api<{ id: string }>('/api/campaigns', { body: { name } });
      navigate(`/c/${id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const join = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { id } = await api<{ id: string }>('/api/campaigns/join', { body: { inviteCode: invite } });
      navigate(`/c/${id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="home">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={24} height={24} />
          <span>dnd-table</span>
        </div>
        <div className="topbar__right">
          <span className="muted">{user.displayName}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="home__main">
        <h2>Your campaigns</h2>
        {campaigns === undefined ? (
          <p className="muted">Loading…</p>
        ) : campaigns.length === 0 ? (
          <p className="muted">None yet. Start one, or join with the invite code from your GM.</p>
        ) : (
          <ul className="campaigns">
            {campaigns.map((c) => (
              <li key={c.id}>
                <Link to={`/c/${c.id}`} className="campaign-card">
                  <span className="campaign-card__name">{c.name}</span>
                  <span className="campaign-card__meta">
                    <span className={`badge ${c.role === 'gm' ? 'badge--gm' : ''}`}>{c.role === 'gm' ? 'GM' : 'Player'}</span>
                    {c.memberCount} {c.memberCount === 1 ? 'member' : 'members'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="form-error">{error}</p>}

        <div className="home__forms">
          <form className="card stack" onSubmit={create}>
            <h3>Start a campaign</h3>
            <p className="muted">You'll be the GM.</p>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Campaign name" maxLength={80} required />
            <button type="submit" className="btn btn--primary">
              Create
            </button>
          </form>
          <form className="card stack" onSubmit={join}>
            <h3>Join a campaign</h3>
            <p className="muted">Enter the invite code from your GM.</p>
            <input
              value={invite}
              onChange={(e) => setInvite(e.target.value.toUpperCase())}
              placeholder="ABC123"
              className="code-input"
              maxLength={12}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              required
            />
            <button type="submit" className="btn">
              Join
            </button>
          </form>
        </div>

        <Link className="table-link" to="/table">
          Use this device as a table screen →
        </Link>
      </main>
    </div>
  );
}

export function Home() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = params.get('next');

  useEffect(() => {
    if (user && next?.startsWith('/')) navigate(next, { replace: true });
  }, [user, next, navigate]);

  if (user === undefined) return <div className="page-loading">Loading…</div>;
  return user ? <Campaigns user={user} /> : <AuthForm />;
}
