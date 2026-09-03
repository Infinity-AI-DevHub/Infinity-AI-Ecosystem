/**
 * The current date and time, ticking.
 *
 * Its own component because two dashboards want it and neither should have to import the
 * other: the employee's home and the command centre both show the clock, and pulling it
 * from the attendance module would drag that whole page in with it.
 *
 * The `children` slot is for whatever the host wants to say underneath — the attendance
 * state on one page, nothing on another.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Clock } from 'lucide-react';

export function LiveClock({ children }: { children?: ReactNode }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <article className="panel datetime-card">
      <Clock size={16} aria-hidden="true" />
      <strong className="datetime-time">
        {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </strong>
      <span className="datetime-date">
        {now.toLocaleDateString(undefined, {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        })}
      </span>
      {children}
    </article>
  );
}
