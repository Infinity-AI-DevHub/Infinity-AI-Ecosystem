/**
 * Meetings this client has been invited to, and notices we have sent them.
 *
 * Both are read-only lists of things addressed to them, so they share a file. The
 * meetings come from the ordinary calendar endpoint, which already joins on attendance —
 * a client sees an event because they are on its invitation list, not because a portal
 * query decided to show it.
 */
import { useMemo } from 'react';
import { CalendarDays, MapPin, Megaphone, Video } from 'lucide-react';
import { api } from '../../lib/api';
import { useQuery } from '../../lib/query';
import { AsyncSection, Empty } from '../../components/States';
import { formatDate, formatDateTime } from '../../lib/format';

type Meeting = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  online_url: string | null;
  starts_at: string;
  ends_at: string;
  rsvp: string | null;
};

export function PortalMeetings() {
  /*
   * A window either side of today rather than only the future: a client checking what
   * was agreed last week needs the meeting that has already happened.
   */
  const range = useMemo(() => {
    const from = new Date();
    from.setMonth(from.getMonth() - 2);
    const to = new Date();
    to.setMonth(to.getMonth() + 6);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  const key = `/calendar/events?from=${range.from}&to=${range.to}`;
  const meetings = useQuery<{ items: Meeting[] }>(key, (signal) => api.get(key, signal));

  return (
    <>
      <header className="portal-head">
        <h1>Meetings</h1>
        <p>Everything you have been invited to.</p>
      </header>

      <AsyncSection query={meetings}>
        {(data) => {
          const now = Date.now();
          const upcoming = data.items
            .filter((m) => new Date(m.ends_at).getTime() >= now)
            .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
          const past = data.items
            .filter((m) => new Date(m.ends_at).getTime() < now)
            .sort((a, b) => b.starts_at.localeCompare(a.starts_at));

          if (data.items.length === 0) {
            return (
              <Empty
                title="No meetings"
                description="Invitations you receive from the team will appear here."
              />
            );
          }

          return (
            <>
              <section className="portal-doc-block">
                <h2>Coming up</h2>
                {upcoming.length === 0 ? (
                  <p className="field-hint">Nothing scheduled.</p>
                ) : (
                  <ul className="portal-meeting-list">
                    {upcoming.map((meeting) => (
                      <MeetingRow key={meeting.id} meeting={meeting} joinable />
                    ))}
                  </ul>
                )}
              </section>

              {past.length > 0 ? (
                <section className="portal-doc-block">
                  <h2>Earlier</h2>
                  <ul className="portal-meeting-list is-past">
                    {past.slice(0, 20).map((meeting) => (
                      <MeetingRow key={meeting.id} meeting={meeting} />
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          );
        }}
      </AsyncSection>
    </>
  );
}

function MeetingRow({ meeting, joinable = false }: { meeting: Meeting; joinable?: boolean }) {
  return (
    <li>
      <CalendarDays size={16} aria-hidden="true" />
      <div className="portal-meeting-body">
        <strong>{meeting.title}</strong>
        <span className="field-hint">
          {formatDateTime(meeting.starts_at)} – {formatDateTime(meeting.ends_at)}
        </span>
        {meeting.location ? (
          <span className="field-hint portal-meeting-where">
            <MapPin size={12} aria-hidden="true" /> {meeting.location}
          </span>
        ) : null}
        {meeting.description ? (
          <span className="field-hint">{meeting.description}</span>
        ) : null}
      </div>
      {joinable && meeting.online_url ? (
        <a
          className="ghost-button"
          href={meeting.online_url}
          target="_blank"
          rel="noreferrer noopener"
        >
          <Video size={14} aria-hidden="true" /> Join
        </a>
      ) : null}
    </li>
  );
}

type Notice = {
  id: string; title: string; body: string; priority: string; publish_at: string;
};

export function PortalNotices() {
  const notices = useQuery<{ items: Notice[] }>('/portal/notices', (signal) =>
    api.get('/portal/notices', signal),
  );

  return (
    <>
      <header className="portal-head">
        <h1>Notices</h1>
        <p>Anything we have needed to tell you.</p>
      </header>

      <AsyncSection query={notices}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty title="No notices" description="Nothing to report at the moment." />
          ) : (
            <ul className="portal-notice-list">
              {data.items.map((notice) => (
                <li key={notice.id} className={`portal-notice priority-${notice.priority}`}>
                  <Megaphone size={16} aria-hidden="true" />
                  <div>
                    <strong>{notice.title}</strong>
                    <span className="field-hint">{formatDate(notice.publish_at)}</span>
                    <p className="portal-notice-body">{notice.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </AsyncSection>
    </>
  );
}
