/**
 * Which dashboard a person lands on.
 *
 * The command centre is built around oversight — approvals waiting on you, company
 * storage, what was announced to everyone. An employee has none of those questions, and
 * showing them that page meant most of it was either empty or not their business. They
 * get their own: their hours, their tasks, their meetings.
 *
 * Chosen by access level rather than capability, deliberately. This is not a security
 * boundary — every widget behind both pages already scopes to the caller — it is a
 * judgement about which summary is useful to whom, and the role is what expresses that.
 */
import { lazy, Suspense } from 'react';
import { useSession } from '../lib/session';
import { Loading } from '../components/States';

const Command = lazy(() => import('./Command'));
const EmployeeHome = lazy(() => import('./EmployeeHome'));

export default function Home() {
  const { capabilities } = useSession();
  const isEmployee = capabilities?.accessLevel === 'staff';

  return (
    <Suspense fallback={<Loading label="Loading your dashboard" rows={4} />}>
      {isEmployee ? <EmployeeHome /> : <Command />}
    </Suspense>
  );
}
