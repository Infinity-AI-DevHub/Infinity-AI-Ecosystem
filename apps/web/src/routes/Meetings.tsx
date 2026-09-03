/**
 * Meetings and calendar (blueprint 05/10).
 *
 * Times are shown in the viewer's own zone. Joining requests a short-lived ticket; when
 * no media provider is configured the screen says so plainly rather than failing.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CalendarPlus, Check, Video, X } from 'lucide-react';
import { api, idempotencyKey } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, DegradedNotice, Empty, ErrorState, Loading, FormError } from '../components/States';
import { durationBetween, formatDate, formatTime, titleCase } from '../lib/format';
import { useSession } from '../lib/session';
import { openExternal } from '../lib/desktop';
import { useNotify } from '../lib/notify';
import { MeetingsCalendar, startOfWeek } from '../components/MeetingsCalendar';

type Event = {
  id: string;
  title: string;
  description: string;
  location: string | null;
  onlineUrl: string | null;
  recurrenceRule: string | null;
  roomId: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: string;
  organizerId: string;
  hasVideoRoom: boolean;
  meetingProvider: string | null;
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
  const { notify } = useNotify();
  const { eventId } = useParams();
  const navigate = useNavigate();
  const { session } = useSession();
  const [creating, setCreating] = useState(false);
  const [ticket, setTicket] = useState<JoinTicket | null>(null);
  const [optimisticRsvp, setOptimisticRsvp] = useState<Event['myRsvp']>(null);
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));

  /*
   * The window follows the view. The agenda keeps its fortnight; the calendar asks for
   * exactly the week on screen, so paging back a week fetches that week rather than
   * showing an empty grid because the range still started today.
   */
  const range = useMemo(() => {
    if (view === 'calendar') {
      const to = new Date(weekStart);
      to.setDate(to.getDate() + 7);
      return { from: weekStart.toISOString(), to: to.toISOString() };
    }
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 14);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [view, weekStart]);

  const listKey = `/calendar/events?from=${range.from}&to=${range.to}`;
  const events = useQuery<{ items: Event[] }>(listKey, (signal) => api.get(listKey, signal));

  const detailKey = eventId ? `/calendar/events/${eventId}` : null;
  const detail = useQuery<EventDetail>(detailKey, (signal) =>
    api.get(`/calendar/events/${eventId}`, signal),
  );

  const rsvp = useMutation(
    async (value: 'accepted' | 'declined' | 'tentative') => {
      await api.post(`/calendar/events/${eventId}/rsvp`, { rsvp: value });
      return value;
    },
    { invalidates: ['/calendar'] },
  );

  const join = useMutation(async () => {
    const result = await api.post<JoinTicket>(`/calendar/events/${eventId}/join`);
    setTicket(result);
    return result;
  });

  useEffect(() => {
    setTicket(null);
    setOptimisticRsvp(null);
  }, [eventId]);

  useEffect(() => {
    if (detail.data?.myRsvp) setOptimisticRsvp(detail.data.myRsvp);
  }, [detail.data?.myRsvp]);

  const respond = async (value: 'accepted' | 'declined' | 'tentative') => {
    const previous = optimisticRsvp ?? detail.data?.myRsvp ?? null;
    setOptimisticRsvp(value);
    const saved = await rsvp.mutate(value);
    if (!saved) setOptimisticRsvp(previous);
  };

  const joinVideoMeeting = async () => {
    const result = await join.mutate();
    if (result && !result.degraded && result.url) await openExternal(result.url);
  };

  // Shared by both views: the same panel sits beside the calendar and the agenda.
  const detailPanel = (
        <section className="panel panel-scroll" aria-label="Meeting detail">
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
              {detail.data.recurrenceRule ? (
                <p className="field-hint">
                  Repeats {String(detail.data.recurrenceRule).includes('DAILY') ? 'daily'
                    : String(detail.data.recurrenceRule).includes('WEEKLY') ? 'weekly' : 'monthly'}
                </p>
              ) : null}
              {/* The scheduled reminder fires once at a fixed offset; this covers the
                  case it does not — a meeting moved, or half the room forgetting. */}
              <button
                type="button"
                className="ghost-button"
                onClick={async () => {
                  try {
                    await api.post(`/calendar/events/${detail.data!.id}/remind`, {});
                    notify({ severity: 'success', title: 'Reminder sent to everyone attending' });
                  } catch {
                    notify({ severity: 'warning', title: 'That reminder could not be sent' });
                  }
                }}
              >
                Send reminder now
              </button>

              {detail.data.onlineUrl ? (
                <p>
                  {/* Through the bridge: in the desktop client a bare target=_blank is
                      caught by the navigation guard, so the link would do nothing. */}
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void openExternal(detail.data!.onlineUrl!)}
                  >
                    Join online
                  </button>
                </p>
              ) : null}
              {detail.data.description ? <p>{detail.data.description}</p> : null}

              {detail.data.hasVideoRoom && detail.data.meetingProvider !== 'none' ? (
                <div className="join-block">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void joinVideoMeeting()}
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
                  ) : null}
                </div>
              ) : detail.data.hasVideoRoom && !detail.data.onlineUrl ? (
                <DegradedNotice reason="Video calling is not available for this meeting because no media provider or online meeting link is configured.">
                  <p>Ask the organiser to add an online meeting link.</p>
                </DegradedNotice>
              ) : null}

              <section aria-labelledby="rsvp-heading" className="rsvp-block">
                <h4 id="rsvp-heading">Your response</h4>
                <div className="rsvp-buttons">
                  {(['accepted', 'tentative', 'declined'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`chip ${(optimisticRsvp ?? detail.data!.myRsvp) === value ? 'chip-active' : ''}`}
                      aria-pressed={(optimisticRsvp ?? detail.data!.myRsvp) === value}
                      onClick={() => void respond(value)}
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
  );

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Meetings</h2>
          <p>
            {view === 'calendar' ? 'The week' : 'Next two weeks'}, shown in{' '}
            {session?.user?.timezone ?? 'your local time'}.
          </p>
        </div>
        <div className="header-controls">
          <div className="tab-row" role="tablist" aria-label="Meeting view">
            {(['calendar', 'list'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={view === mode}
                className={`tab ${view === mode ? 'tab-active' : ''}`}
                onClick={() => setView(mode)}
              >
                {mode === 'calendar' ? 'Calendar' : 'Agenda'}
              </button>
            ))}
          </div>
          <button type="button" className="primary-button" onClick={() => setCreating(true)}>
            <CalendarPlus size={15} aria-hidden="true" /> Schedule
          </button>
        </div>
      </header>

      {view === 'calendar' ? (
        <div className="split-layout calendar-layout">
          <section className="panel" aria-label="Calendar">
            <AsyncSection query={events}>
              {(data) => (
                <MeetingsCalendar
                  events={data.items}
                  weekStart={weekStart}
                  onWeekChange={setWeekStart}
                  selectedId={eventId ?? null}
                  onSelect={(id: string) => navigate(`/meetings/${id}`)}
                />
              )}
            </AsyncSection>
          </section>
          {detailPanel}
        </div>
      ) : (
      <div className="split-layout">
        <section className="panel panel-scroll" aria-label="Agenda">
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

        {detailPanel}
      </div>
      )}

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
  const [onlineUrl, setOnlineUrl] = useState('');
  const [repeat, setRepeat] = useState<'none' | 'DAILY' | 'WEEKLY' | 'MONTHLY'>('none');
  const [repeatCount, setRepeatCount] = useState('1');
  const [agenda, setAgenda] = useState('');
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
      const occurrenceCount = Math.min(
        365,
        Math.max(1, Number.parseInt(repeatCount, 10) || 1),
      );
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
          onlineUrl: onlineUrl.trim() || null,
          /**
           * COUNT rather than an open-ended series. A meeting that repeats forever is
           * one nobody ever cancels, and the server caps what it will expand anyway.
           */
          recurrenceRule:
            repeat === 'none' ? null : `FREQ=${repeat};COUNT=${occurrenceCount}`,
          agenda: agenda.trim() || undefined,
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

          <div className="field-row">
            <div className="field">
              <label htmlFor="meeting-repeat">Repeats</label>
              <select
                id="meeting-repeat"
                value={repeat}
                onChange={(event) => setRepeat(event.target.value as typeof repeat)}
              >
                <option value="none">Does not repeat</option>
                <option value="DAILY">Every day</option>
                <option value="WEEKLY">Every week</option>
                <option value="MONTHLY">Every month</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="meeting-repeat-count">Occurrences</label>
              <input
                id="meeting-repeat-count"
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                step={1}
                value={repeatCount}
                onChange={(event) => setRepeatCount(event.target.value)}
                disabled={repeat === 'none'}
                required={repeat !== 'none'}
              />
              <p className="field-hint">
                Enter 1–365 meetings. Choose 1 for a single occurrence.
              </p>
            </div>
          </div>

          <div className="field">
            <label htmlFor="meeting-link">Online meeting link</label>
            <input
              id="meeting-link"
              type="url"
              inputMode="url"
              placeholder="https://meet.example.com/your-room"
              value={onlineUrl}
              onChange={(event) => setOnlineUrl(event.target.value)}
            />
            <p className="field-hint">
              Sent to everyone invited. Must start with https.
            </p>
          </div>

          <div className="field">
            <label htmlFor="meeting-agenda">Agenda and notes</label>
            <textarea
              id="meeting-agenda"
              rows={3}
              value={agenda}
              onChange={(event) => setAgenda(event.target.value)}
              placeholder={'1. Scope\n2. Timeline\n3. Next steps'}
            />
            <p className="field-hint">Included in the invitation email.</p>
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

          {/* Beside the button that caused it. At the top of the dialog it rendered
              above the scroll, so a rejected submit looked like nothing happening. */}
          <FormError error={create.error} />

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
