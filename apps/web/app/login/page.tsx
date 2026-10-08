'use client';

/**
 * Halaman masuk — desain baru (kartu radius 18px, logo gradien, latar
 * radial halus). Memakai .login-wrap/.login-card dari globals.css.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { login, ApiError } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setWait(true);
    try {
      await login(username, password);
      router.replace('/');
    } catch (err) {
      const m = err instanceof ApiError ? err.message : 'Gagal terhubung';
      setError(
        m === 'rate_limited'
          ? 'Terlalu banyak percobaan. Tunggu beberapa menit.'
          : m === 'invalid_credentials'
            ? 'Username atau password salah.'
            : m === 'csrf_token_invalid'
              ? 'Token kedaluwarsa — muat ulang halaman.'
              : m,
      );
      setWait(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card card">
        <div className="card-body p-4 p-sm-5">
          <div className="login-logo">
            <i className="fa-solid fa-network-wired" />
          </div>
          <h1 className="h5 text-center mb-1">ACS TR-069</h1>
          <p className="text-center text-muted small mb-4">
            Masuk untuk mengelola perangkat
          </p>

          {error && (
            <div className="alert alert-danger py-2 small" role="alert">{error}</div>
          )}

          <form onSubmit={submit}>
            <div className="mb-3">
              <label className="form-label" htmlFor="username">Username</label>
              <input
                id="username" type="text" className="form-control"
                placeholder="admin" value={username} autoComplete="username"
                autoFocus required
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="mb-4">
              <label className="form-label" htmlFor="password">Password</label>
              <input
                id="password" type="password" className="form-control"
                placeholder="••••••••" value={password} autoComplete="current-password"
                required
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary w-100" disabled={wait}>
              {wait ? (
                <>
                  <span className="spinner-border spinner-border-sm me-2" role="status" />
                  Memeriksa…
                </>
              ) : (
                <>
                  <i className="fa-solid fa-right-to-bracket me-2" />Masuk
                </>
              )}
            </button>
          </form>

          <p className="text-center text-muted small mt-4 mb-0">
            Lupa password? Reset database sesi admin (lihat dokumentasi).
          </p>
        </div>
      </div>
    </div>
  );
}
