import { titleCase } from '../lib/format';

/**
 * A task priority must never be communicated by colour alone. The visible label helps
 * everyone scan the board, while the explicit accessible name gives assistive
 * technology the same information without making it infer meaning from decoration.
 */
export function TaskPriority({ priority }: { priority: string }) {
  const label = titleCase(priority || 'unknown');

  return (
    <span
      className="task-priority-badge"
      aria-label={`Priority: ${label}`}
      title={`${label} priority`}
    >
      <span className={`priority-dot priority-${priority}`} aria-hidden="true" />
      <span aria-hidden="true">{label}</span>
    </span>
  );
}
