/**
 * Meetings and calendar (blueprint 05/10).
 *
 * Times are shown in the viewer's own zone. Joining requests a short-lived ticket; when
 * no media provider is configured the screen says so plainly rather than failing.
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CalendarPlus, Check, Video, X } from 'lucide-react';
import { api, idempotencyKey } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, DegradedNotice, Empty, ErrorState, Loading, FormError } from '../components/States';
import { durationBetween, formatDate, formatTime, titleCase } from '../lib/format';
import { useSession } from '../lib/session';

type Event = {
  id: string;
  title: string;
  description: string;
  location: string | null;
  roomId: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: string;
  organizerId: string;
  hasVideoRoom: boolean;
  agenda: string;
  attendeeCount?: number;
  myRsvp: string | null;
  version: number;
};

type EventDetail = Event & {
  attendees: { user_id: string; role: string; rsvp: string; display_name: string; email: string }[];
};

type JoinTicket = { provider: string; url: string; token: string; degraded: boolean; reason?: string };

type Person = { id: string; displayName: string; email: string };
type Room = { id: string; name: string; capacity: number; location: string | null; active: boolean };

/** Groups events by calendar day for a readable agenda. */
function groupByDay(events: Event[]): [string, Event[]][] {
  const groups = new Map<string, Event[]>();
  for (const event of events) {
    const day = new Date(event.startsAt).toDateString();
    const bucket = groups.get(day);
    if (bucket) bucket.push(event);
    else groups.set(day, [event]);
  }
  return [...groups.entries()];
}

export default function Meetings() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const { session } = useSession();
  const [creating, setCreating] = useState(false);
  const [ticket, setTicket] = useState<JoinTicket | null>(null);

  // A fortnight window keeps the agenda useful without unbounded pagination.
  const range = useMemo(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 14);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  const listKey = `/calendar/events?from=${range.from}&to=${range.to}`;
  const events = useQuery<{ items: Event[] }>(listKey, (signal) => api.get(listKey, signal));

  const detailKey = eventId ? `/calendar/events/${eventId}` : null;
  const detail = useQuery<EventDetail>(detailKey, (signal) =>
    api.get(`/calendar/events/${eventId}`, signal),
  );

  const rsvp = useMutation(
    async (value: 'accepted' | 'declined' | 'tentative') =>
      api.post(`/calendar/events/${eventId}/rsvp`, { rsvp: value }),
    { invalidates: ['/calendar'] },
  );

  const join = useMutation(async () => {
    const result = await api.post<JoinTicket>(`/calendar/events/${eventId}/join`);
    setTicket(result);
    return result;
  });

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Meetings</h2>
          <p>Next two weeks, shown in {session?.user?.timezone ?? 'your local time'}.</p>
        </div>
        <button type="button" className="primary-button" onClick={() => setCreating(true)}>
          <CalendarPlus size={15} aria-hidden="true" /> Schedule
        </button>
      </header>

      <div className="split-layout">
        <section className="panel" aria-label="Agenda">
          <AsyncSection query={events}>
            {(data) =>
              data.items.length === 0 ? (
                <Empty
                  title="Nothing scheduled"
                  description="Your next two weeks are clear."
                  action={
                    <button type="button" className="ghost-button" onClick={() => setCreating(true)}>
                      Schedule a meeting
                    </button>
                  }
                />
              ) : (
                <div className="agenda">
                  {groupByDay(data.items).map(([day, dayEvents]) => (
                    <div key={day} className="agenda-day">
                      <h3>{formatDate(dayEvents[0]!.startsAt)}</h3>
                      <ul>
                        {dayEvents.map((event) => (
                          <li key={event.id}>
                            <button
                              type="button"
                              className={`agenda-item ${event.id === eventId ? 'agenda-active' : ''}`}
                              onClick={() => navigate(`/meetings/${event.id}`)}
                            >
                              <time dateTime={event.startsAt}>{formatTime(event.startsAt)}</time>
                              <div>
                                <strong>{event.title}</strong>
                                <span>
                                  {durationBetween(event.startsAt, event.endsAt)}
                                  {event.hasVideoRoom ? ' · Video' : ''}
                                  {event.myRsvp === 'needs_action' ? ' · Response needed' : ''}
                                </span>
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )
            }
          </AsyncSection>
        </section>

        <section className="panel" aria-label="Meeting detail">
          {!eventId ? (
            <Empty title="Select a meeting" description="Choose a meeting to see its details." />
          ) : detail.loading ? (
            <Loading label="Loading meeting" />
          ) : detail.error ? (
            <ErrorState error={detail.error} onRetry={detail.reload} />
          ) : detail.data ? (
            <article className="meeting-detail">
              <h3>{detail.data.title}</h3>
              <p className="meeting-when">
                <time dateTime={detail.data.startsAt}>
                  {formatDate(detail.data.startsAt)} · {formatTime(detail.data.startsAt)}
                </time>
                {' – '}
                <time dateTime={detail.data.endsAt}>{formatTime(detail.data.endsAt)}</time>
                <span className="meeting-zone"> (organised in {detail.data.timezone})</span>
              </p>

              {detail.data.location ? <p>{detail.data.location}</p> : null}
              {detail.data.description ? <p>{detail.data.description}</p> : null}

              {detail.data.hasVideoRoom ? (
                <div className="join-block">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void join.mutate()}
                    disabled={join.pending}
                  >
                    <Video size={15} aria-hidden="true" />
                    {join.pending ? 'Preparing…' : 'Join video meeting'}
                  </button>

                  {ticket?.degraded ? (
                    <DegradedNotice
                      reason={ticket.reason ?? 'The media provider is not available right now.'}
                    >
                      <p>Meeting details, agenda and notes remain available.</p>
                    </DegradedNotice>
                  ) : ticket ? (
                    <p className="join-ready" role="status">
                      Your secure join ticket is ready for {ticket.provider}. It expires shortly,
                      so join now.
                    </p>
                  ) : null}
                </div>
              ) : null}

              <section aria-labelledby="rsvp-heading" className="rsvp-block">
                <h4 id="rsvp-heading">Your response</h4>
                <div className="rsvp-buttons">
                  {(['accepted', 'tentative', 'declined'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`chip ${detail.data!.myRsvp === value ? 'chip-active' : ''}`}
                      aria-pressed={detail.data!.myRsvp === value}
                      onClick={() => void rsvp.mutate(value).then(() => detail.reload())}
                      disabled={rsvp.pending}
                    >
                      {value === 'accepted' ? <Check size={13} aria-hidden="true" /> : null}
                      {value === 'declined' ? <X size={13} aria-hidden="true" /> : null}
                      {titleCase(value)}
                    </button>
                  ))}
                </div>
              </section>

              <section aria-labelledby="attendees-heading">
                <h4 id="attendees-heading">Attendees ({detail.data.attendees.length})</h4>
                <ul className="attendee-list">
                  {detail.data.attendees.map((attendee) => (
                    <li key={attendee.user_id}>
                      <span>{attendee.display_name}</span>
                      <span className={`rsvp-tag rsvp-${attendee.rsvp}`}>
                        {titleCase(attendee.rsvp)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              {detail.data.agenda ? (
                <section aria-labelledby="agenda-heading">
                  <h4 id="agenda-heading">Agenda</h4>
                  <p className="meeting-agenda">{detail.data.agenda}</p>
                </section>
              ) : null}
            </article>
          ) : null}
        </section>
      </div>

      {creating ? (
        <ScheduleDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            invalidate('/calendar');
            navigate(`/meetings/${id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function ScheduleDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { session } = useSession();
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [startTime, setStartTime] = useState('10:00');
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [attendeeIds, setAttendeeIds] = useState<string[]>([]);
  const [roomId, setRoomId] = useState('');
  const [withVideo, setWithVideo] = useState(true);
  const key = useMemo(() => idempotencyKey(), []);

  const people = useQuery<{ items: Person[] }>('/users?limit=100', (signal) =>
    api.get('/users?limit=100', signal),
  );
  const rooms = useQuery<{ items: Room[] }>('/calendar/rooms', (signal) =>
    api.get('/calendar/rooms', signal),
  );

  const create = useMutation(
    async () => {
      // The local wall-clock values are converted to a real instant before sending.
      const startsAt = new Date(`${date}T${startTime}`);
      const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
      return api.post<Event>(
        '/calendar/events',
        {
          title,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          timezone: session?.user?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          attendeeIds,
          roomId: roomId || null,
          withVideoRoom: withVideo,
        },
        { idempotencyKey: key },
      );
    },
    { invalidates: ['/calendar'], onSuccess: (event) => onCreated(event.id) },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="schedule-title">Schedule a meeting</h3>

        <FormError error={create.error} />

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create.mutate();
          }}
        >
          <div className="field">
            <label htmlFor="meeting-title">Title</label>
            <input
              id="meeting-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="meeting-date">Date</label>
              <input
                id="meeting-date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="meeting-time">Start</label>
              <input
                id="meeting-time"
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="meeting-duration">Length</label>
              <select
                id="meeting-duration"
                value={durationMinutes}
                onChange={(event) => setDurationMinutes(Number(event.target.value))}
              >
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={45}>45 minutes</option>
                <option value={60}>1 hour</option>
                <option value={90}>90 minutes</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label htmlFor="meeting-room">Room</label>
            <select
              id="meeting-room"
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
            >
              <option value="">No room</option>
              {(rooms.data?.items ?? [])
                .filter((room) => room.active)
                .map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name} (seats {room.capacity})
                  </option>
                ))}
            </select>
            <p className="field-hint">
              Double bookings are refused by the server, so a clash is reported immediately.
            </p>
          </div>

          <fieldset className="field">
            <legend>Attendees</legend>
            <div className="attendee-picker">
              {(people.data?.items ?? []).map((person) => (
                <label key={person.id} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={attendeeIds.includes(person.id)}
                    onChange={(event) =>
                      setAttendeeIds((current) =>
                        event.target.checked
                          ? [...current, person.id]
                          : current.filter((id) => id !== person.id),
                      )
                    }
                  />
                  {person.displayName}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={withVideo}
              onChange={(event) => setWithVideo(event.target.checked)}
            />
            Include a video room
          </label>

          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={create.pending}>
              {create.pending ? 'Scheduling…' : 'Schedule meeting'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
