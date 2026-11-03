import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import Login from './pages/Login';
import Profile from './pages/Profile';
import Board from './pages/Board';
import Team from './pages/Team';
import Suggestions from './pages/Suggestions';
import Organizer from './pages/Organizer';
import { subscribeConnectionState } from './realtime';

function Nav() {
  const { token, logout } = useAuth();
  const navigate = useNavigate();
  if (!token) return null;
  const link = ({ isActive }: { isActive: boolean }) => `nav-link ${isActive ? 'active' : ''}`;
  return (
    <nav aria-label="Main" className="app-header">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-1 px-4 py-3 sm:gap-2 sm:px-8">
        <Link to="/board" className="mr-2 flex items-center gap-2.5 text-lg font-bold tracking-tight text-slate-900 sm:mr-6"><span className="brand-mark" aria-hidden="true">T</span>TeamForm</Link>
        <NavLink to="/board" className={link}>Board</NavLink>
        <NavLink to="/suggestions" className={link}>Suggestions</NavLink>
        <NavLink to="/profile" className={link}>Profile</NavLink>
        <NavLink to="/organizer" className={link}>Organizer</NavLink>
        <button
          className="btn-ghost ml-auto"
          onClick={() => { logout(); navigate('/login'); }}
        >
          Log out
        </button>
      </div>
    </nav>
  );
}

function LiveState() {
  const [state, setState] = useState<'live' | 'reconnecting' | 'polling'>('polling');
  useEffect(() => subscribeConnectionState(setState), []);
  if (state !== 'reconnecting') return null;
  return (
    <div role="status" className="bg-amber-50 px-4 py-1.5 text-center text-xs font-medium text-amber-800">
      Connection to live updates dropped - reconnecting. You can keep working; changes will catch up.
    </div>
  );
}

export default function App() {
  const { token } = useAuth();
  return (
    <div className="min-h-screen">
      <a href="#main" className="skip-link">Skip to content</a>
      <Nav />
      <LiveState />
      <main id="main" className="mx-auto max-w-7xl px-4 py-7 sm:px-8 sm:py-10">
        <Routes>
          <Route path="/login" element={token ? <Navigate to="/board" replace /> : <Login />} />
          <Route path="/board" element={token ? <Board /> : <Navigate to="/login" replace />} />
          <Route path="/team/:id" element={token ? <Team /> : <Navigate to="/login" replace />} />
          <Route path="/suggestions" element={token ? <Suggestions /> : <Navigate to="/login" replace />} />
          <Route path="/profile" element={token ? <Profile /> : <Navigate to="/login" replace />} />
          <Route path="/organizer" element={token ? <Organizer /> : <Navigate to="/login" replace />} />
          <Route path="*" element={<Navigate to={token ? '/board' : '/login'} replace />} />
        </Routes>
      </main>
    </div>
  );
}
