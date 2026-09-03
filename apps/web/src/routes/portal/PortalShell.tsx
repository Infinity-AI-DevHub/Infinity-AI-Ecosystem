/**
 * The client portal's frame.
 *
 * Deliberately not the workspace Shell. That one carries twenty-odd modules, a command
 * palette, presence and a notification centre — all of it built for someone who works
 * here. A client wants four things and a way out, and every extra control is a question
 * about what else this company's system does.
 *
 * It also keeps the public bundle small: importing the workspace Shell would pull the
 * whole authenticated application onto a host that exists to serve people without
 * accounts.
 */
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { FileText, FolderOpen, LayoutDashboard, LogOut, Receipt, CheckSquare } from 'lucide-react';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';

const LINKS = [
  { to: '/portal', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/portal/invoices', label: 'Invoices', icon: Receipt },
  { to: '/portal/quotations', label: 'Quotations', icon: FileText },
  { to: '/portal/documents', label: 'Documents', icon: FolderOpen },
  { to: '/portal/tasks', label: 'Work', icon: CheckSquare },
];

export function PortalShell() {
  const { session } = useSession();
  const navigate = useNavigate();

  async function signOut() {
    try {
      await api.post('/auth/logout', {});
    } finally {
      navigate('/portal/sign-in', { replace: true });
    }
  }

  return (
    <div className="portal">
      <header className="portal-bar">
        <div className="portal-brand">
          <span className="portal-mark" aria-hidden="true">∞</span>
          <span>
            <strong>Infinity AI</strong>
            <span className="portal-org">{session?.user?.displayName}</span>
          </span>
        </div>

        <nav className="portal-nav" aria-label="Client portal">
          {LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) => `portal-link ${isActive ? 'is-active' : ''}`}
            >
              <link.icon size={15} aria-hidden="true" />
              {link.label}
            </NavLink>
          ))}
        </nav>

        <button type="button" className="ghost-button" onClick={() => void signOut()}>
          <LogOut size={14} aria-hidden="true" /> Sign out
        </button>
      </header>

      <main className="portal-main" id="main">
        <Outlet />
      </main>

      <footer className="portal-foot">
        <p>
          Questions about anything here? Reply to the email this came from and one of us
          will pick it up.
        </p>
      </footer>
    </div>
  );
}
