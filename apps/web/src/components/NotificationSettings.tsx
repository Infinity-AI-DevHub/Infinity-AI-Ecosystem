/**
 * How this machine behaves when something happens.
 *
 * These are device settings, not account settings, and the copy says so. Whether a
 * laptop should make a noise depends on where it is sitting - a shared desk, a client
 * meeting - not on who is signed in to it.
 */
import { playChime, useNotify } from '../lib/notify';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const label = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

export function NotificationSettings() {
  const { preferences, setPreferences, notify } = useNotify();
  const quietActive = preferences.quietFrom !== preferences.quietTo;

  return (
    <section className="panel" aria-labelledby="notify-heading">
      <h3 id="notify-heading">Notifications</h3>
      <p className="field-hint">
        These apply to this device only. Signing in elsewhere will not carry them over.
      </p>

      <div className="checkbox-row">
        <label>
          <input
            type="checkbox"
            checked={preferences.bannersEnabled}
            onChange={(event) =>
              setPreferences({ ...preferences, bannersEnabled: event.target.checked })
            }
          />
          Show banners when something arrives
        </label>
      </div>

      <div className="checkbox-row">
        <label>
          <input
            type="checkbox"
            checked={preferences.soundEnabled}
            onChange={(event) =>
              setPreferences({ ...preferences, soundEnabled: event.target.checked })
            }
          />
          Play a sound
        </label>
      </div>

      <fieldset className="field">
        <legend>Quiet hours</legend>
        <p className="field-hint">
          Silences sound and banners between these times. Notifications still arrive and
          are still counted as unread — only the alert is suppressed.
        </p>
        <div className="field-row">
          <label className="field">
            <span>From</span>
            <select
              value={preferences.quietFrom}
              onChange={(event) =>
                setPreferences({ ...preferences, quietFrom: Number(event.target.value) })
              }
            >
              {HOURS.map((hour) => <option key={hour} value={hour}>{label(hour)}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Until</span>
            <select
              value={preferences.quietTo}
              onChange={(event) =>
                setPreferences({ ...preferences, quietTo: Number(event.target.value) })
              }
            >
              {HOURS.map((hour) => <option key={hour} value={hour}>{label(hour)}</option>)}
            </select>
          </label>
        </div>
        <p className="field-hint">
          {quietActive
            ? `Quiet between ${label(preferences.quietFrom)} and ${label(preferences.quietTo)}.`
            : 'Set both to the same time to switch quiet hours off.'}
        </p>
      </fieldset>

      <div className="field">
        <span className="label-row">Try them</span>
        <div className="table-actions">
          {(['info', 'success', 'warning', 'critical'] as const).map((severity) => (
            <button
              key={severity}
              type="button"
              className="ghost-button"
              onClick={() => {
                // Play regardless of quiet hours: this is the person deliberately
                // asking to hear it, not the application deciding to interrupt.
                if (preferences.soundEnabled) playChime(severity);
                notify({
                  severity,
                  title: `${severity[0].toUpperCase()}${severity.slice(1)} alert`,
                  body: 'This is how one of these will look and sound.',
                });
              }}
            >
              {severity}
            </button>
          ))}
        </div>
        <p className="field-hint">
          Critical alerts stay on screen until dismissed; the others clear themselves.
        </p>
      </div>
    </section>
  );
}
