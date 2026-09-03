/**
 * A week at a glance.
 *
 * An agenda list answers "what is next"; it does not answer "when am I free on Thursday",
 * which is the question people actually open a calendar to settle. Time is drawn to
 * scale here, so a gap looks like a gap and a clash looks like a clash.
 *
 * Deliberately a week rather than a month: a month grid at this size shows a title and
 * nothing else, and the workspace schedules within days.
 */
import { useEffect, useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight, Video } from 'lucide-react';

export type CalendarEvent = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  hasVideoRoom: boolean;
  location: string | null;
  myRsvp: string | null;
};

/** The hours drawn. Outside these, events are still placed - clamped to the edge. */
const DAY_START = 7;
const DAY_END = 21;
const HOUR_HEIGHT = 52;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function startOfWeek(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/** Minutes from the top of the drawn day, clamped so a 6am event still appears. */
function offsetMinutes(date: Date): number {
  return Math.max(0, Math.min((DAY_END - DAY_START) * 60, (date.getHours() - DAY_START) * 60 + date.getMinutes()));
}

/**
 * Overlapping meetings share the width of their column.
 *
 * Without this, two meetings at the same hour sit exactly on top of each other and the
 * second one is invisible - which is the one case a calendar exists to make obvious.
 */
function laneOut(events: CalendarEvent[]): { event: CalendarEvent; lane: number; lanes: number }[] {
  const sorted = [...events].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  const placed: { event: CalendarEvent; lane: number; start: number; end: number }[] = [];

  for (const event of sorted) {
    const start = new Date(event.startsAt).getTime();
    const end = new Date(event.endsAt).getTime();
    const clashing = placed.filter((p) => p.start < end && start < p.end);
    const taken = new Set(clashing.map((p) => p.lane));
    let lane = 0;
    while (taken.has(lane)) lane += 1;
    placed.push({ event, lane, start, end });
  }

  return placed.map((p) => {
    const clashing = placed.filter((o) => o.start < p.end && p.start < o.end);
    const lanes = Math.max(...clashing.map((o) => o.lane)) + 1;
    return { event: p.event, lane: p.lane, lanes };
  });
}

export function MeetingsCalendar({
  events,
  weekStart,
  onWeekChange,
  selectedId,
  onSelect,
}: {
  events: CalendarEvent[];
  weekStart: Date;
  onWeekChange: (next: Date) => void;
  selectedId?: string | null;
  onSelect: (id: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const today = new Date();

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => {
      const day = new Date(weekStart);
      day.setDate(day.getDate() + i);
      return day;
    }),
    [weekStart],
  );

  const byDay = useMemo(
    () => days.map((day) => laneOut(
      events.filter((event) => sameDay(new Date(event.startsAt), day)),
    )),
    [days, events],
  );

  // Open near the working day rather than at midnight.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = Math.max(0, (9 - DAY_START) * HOUR_HEIGHT - 20);
  }, []);

  const hours = Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i);
  const showNow = days.some((day) => sameDay(day, today));
  const nowTop = (offsetMinutes(today) / 60) * HOUR_HEIGHT;

  const rangeLabel = `${days[0]!.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${
    days[6]!.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;

  const shift = (weeks: number) => {
    const next = new Date(weekStart);
    next.setDate(next.getDate() + weeks * 7);
    onWeekChange(next);
  };

  return (
    <div className="calendar">
      <header className="calendar-bar">
        <button type="button" className="ghost-button" onClick={() => onWeekChange(startOfWeek(new Date()))}>
          Today
        </button>
        <div className="calendar-nav">
          <button type="button" className="icon-button" aria-label="Previous week" onClick={() => shift(-1)}>
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" aria-label="Next week" onClick={() => shift(1)}>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
        <strong className="calendar-range">{rangeLabel}</strong>
      </header>

      <div className="calendar-head">
        <span className="calendar-gutter" aria-hidden="true" />
        {days.map((day) => (
          <div key={day.toISOString()} className={`calendar-day-head ${sameDay(day, today) ? 'is-today' : ''}`}>
            <span className="calendar-dow">{DAY_NAMES[day.getDay()]}</span>
            <span className="calendar-dom">{day.getDate()}</span>
          </div>
        ))}
      </div>

      <div className="calendar-scroll" ref={scroller}>
        <div className="calendar-grid" style={{ ['--hour-height' as string]: `${HOUR_HEIGHT}px` }}>
          <div className="calendar-gutter">
            {hours.map((hour) => (
              <div key={hour} className="calendar-hour-label">
                {new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: 'numeric' })}
              </div>
            ))}
          </div>

          {days.map((day, index) => (
            <div key={day.toISOString()} className={`calendar-col ${sameDay(day, today) ? 'is-today' : ''}`}>
              {hours.map((hour) => <div key={hour} className="calendar-slot" />)}

              {showNow && sameDay(day, today) ? (
                <div className="calendar-now" style={{ top: `${nowTop}px` }} aria-hidden="true" />
              ) : null}

              {byDay[index]!.map(({ event, lane, lanes }) => {
                const start = new Date(event.startsAt);
                const end = new Date(event.endsAt);
                const top = (offsetMinutes(start) / 60) * HOUR_HEIGHT;
                const height = Math.max(
                  22,
                  ((offsetMinutes(end) - offsetMinutes(start)) / 60) * HOUR_HEIGHT - 2,
                );
                return (
                  <button
                    key={event.id}
                    type="button"
                    className={`calendar-event ${selectedId === event.id ? 'is-selected' : ''} ${
                      event.myRsvp === 'declined' ? 'is-declined' : ''}`}
                    style={{
                      top: `${top}px`,
                      height: `${height}px`,
                      left: `calc(${(lane / lanes) * 100}% + 2px)`,
                      width: `calc(${100 / lanes}% - 4px)`,
                    }}
                    onClick={() => onSelect(event.id)}
                  >
                    <span className="calendar-event-time">
                      {start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                    </span>
                    <span className="calendar-event-title">{event.title}</span>
                    {event.hasVideoRoom ? (
                      <Video size={11} className="calendar-event-icon" aria-label="Online" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
