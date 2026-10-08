'use client';

/**
 * Toggle tema terang/gelap. Menyimpan pilihan di localStorage dan
 * menerapkannya dengan mengubah data-bs-theme pada <html> — AdminLTE 4
 * dan Bootstrap 5 memakai atribut itu untuk seluruh variabel warna.
 */
import { useEffect, useState } from 'react';

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('acs-theme');
    const preferDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setDark(saved ? saved === 'dark' : preferDark);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
    localStorage.setItem('acs-theme', dark ? 'dark' : 'light');
  }, [dark]);

  return (
    <button
      className="nav-link btn btn-sm"
      onClick={() => setDark((d) => !d)}
      aria-label="Ganti tema"
      title={dark ? 'Mode terang' : 'Mode gelap'}
    >
      <i className={`fas ${dark ? 'fa-sun' : 'fa-moon'}`} />
    </button>
  );
}