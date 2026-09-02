/**
 * Choosing one or more people.
 *
 * A multi-select listbox rather than a native `<select multiple>`: that control requires
 * ctrl-clicking to add a second person, which almost nobody discovers, and it is close to
 * unusable on a trackpad.
 *
 * Selection is shown as removable chips above the list, so who is on the task is legible
 * without scrolling a list to find the highlighted rows.
 */
import { useMemo, useState } from 'react';

export type Person = { id: string; display_name: string; email_display?: string };

export function PeoplePicker({
  people,
  selected,
  onChange,
  label,
  emptyHint = 'Nobody assigned',
}: {
  people: Person[];
  selected: string[];
  onChange: (ids: string[]) => void;
  label: string;
  emptyHint?: string;
}) {
  const [filter, setFilter] = useState('');

  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return people;
    return people.filter(
      (p) =>
        p.display_name.toLowerCase().includes(needle) ||
        (p.email_display ?? '').toLowerCase().includes(needle),
    );
  }, [people, filter]);

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div className="field">
      <span className="label-row">{label}</span>

      <div className="picker-chips">
        {selected.length === 0 ? (
          <span className="field-hint">{emptyHint}</span>
        ) : (
          selected.map((id) => (
            <span key={id} className="chip chip-active">
              {byId.get(id)?.display_name ?? 'Unknown'}
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${byId.get(id)?.display_name ?? 'person'}`}
                onClick={() => toggle(id)}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>

      <input
        type="search"
        value={filter}
        placeholder="Search people…"
        onChange={(event) => setFilter(event.target.value)}
        aria-label={`Filter ${label.toLowerCase()}`}
      />

      <ul className="picker-list" role="listbox" aria-multiselectable="true" aria-label={label}>
        {visible.length === 0 ? (
          <li className="field-hint">Nobody matches that.</li>
        ) : (
          visible.map((person) => {
            const isOn = selected.includes(person.id);
            return (
              <li key={person.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isOn}
                  className={`picker-option ${isOn ? 'picker-option-on' : ''}`}
                  onClick={() => toggle(person.id)}
                >
                  <span className="picker-tick" aria-hidden="true">{isOn ? '✓' : ''}</span>
                  <span>{person.display_name}</span>
                  {person.email_display ? (
                    <span className="field-hint">{person.email_display}</span>
                  ) : null}
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
