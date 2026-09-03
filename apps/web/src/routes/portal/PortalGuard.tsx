/**
 * Who is allowed past the portal's front door.
 *
 * Two refusals, and they are different. Someone with no session goes to sign-in. Someone
 * with a *staff* session gets told plainly that the portal is not their surface — that
 * case is not a security boundary (the API would refuse them the portal endpoints
 * anyway), it is an employee who followed a client's link and would otherwise see an
 * empty portal and assume it is broken.
 */
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useSession } from '../../lib/session';

export function PortalGuard({ children }: { children: ReactNode }) {
  const { status, session, can } = useSession();

  if (status === 'loading') {
    return (
      <main className="share-page">
        <section className="share-card">
          <p className="auth-lead">Loading…</p>
        </section>
      </main>
    );
  }

  if (status !== 'authenticated' || !session?.user) {
    return <Navigate to="/portal/sign-in" replace />;
  }

  if (!can('portal.read')) {
    return (
      <main className="share-page">
        <section className="share-card">
          <h1>This is the client portal</h1>
          <p className="auth-lead">
            Your account is an Infinity AI staff account, so there is nothing for you here.
            Use the desktop app for your work.
          </p>
        </section>
      </main>
    );
  }

  return <>{children}</>;
}
