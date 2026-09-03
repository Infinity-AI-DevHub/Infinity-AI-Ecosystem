/**
 * Who is on a project.
 *
 * `project_members` was written once when the project was created and never touched
 * again — there was no API and no screen for it — so membership was fixed for life and
 * anyone joining the work afterwards could not see its tasks. Project membership is what
 * task access is built on, so this is the screen that lets somebody in.
 *
 * Guests are deliberately absent. A client reaches an individual task, document or
 * folder through a share; putting them on the project would hand them the whole board.
 */
import { useCallback, useEffect, useState } from 'react';
import { Trash2, UserPlus } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useNotify } from '../lib/notify';
import { useConfirm } from './Prompt';
import { PeoplePicker } from './PeoplePicker';

type Member = {
  user_id: string;
  display_name: string;
  email_display: string | null;
  role: string | null;
};

type Colleague = { id: string; displayName: string; email: string; accessLevel: string };

export function ProjectMembers({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { notify } = useNotify();
  const { confirm, element: confirmElement } = useConfirm();
  const [members, setMembers] = useState<Member[]>([]);
  const [candidates, setCandidates] = useState<Colleague[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await api.get<{ items: Member[] }>(`/projects/${projectId}/members`);
    setMembers(result.items);
  }, [projectId]);

  useEffect(() => { void load().catch(() => undefined); }, [load]);

  useEffect(() => {
    void api.get<{ items: Colleague[] }>('/users?limit=100')
      .then((result) => setCandidates(result.items))
      .catch(() => undefined);
  }, []);

  // Only people not already on it, so the list is a list of things you can actually do.
  const onProject = new Set(members.map((m) => m.user_id));
  const addable = candidates.filter((person) => !onProject.has(person.id));

  async function add() {
    if (chosen.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      const result = await api.post<{ added: number }>(`/projects/${projectId}/members`, {
        userIds: chosen,
      });
      setChosen([]);
      await load();
      notify({
        severity: 'success',
        title: `${result.added} ${result.added === 1 ? 'person' : 'people'} added to the project`,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'They could not be added');
    } finally {
      setBusy(false);
    }
  }

  async function remove(member: Member) {
    const yes = await confirm({
      title: `Remove ${member.display_name}?`,
      description: 'They lose access to this project’s tasks. Their past work and comments stay.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!yes) return;
    try {
      await api.delete(`/projects/${projectId}/members/${member.user_id}`);
      await load();
    } catch (err) {
      notify({
        severity: 'warning',
        title: err instanceof ApiError ? err.message : 'They could not be removed',
      });
    }
  }

  return (
    <section className="project-members" aria-label="Project members">
      <h4>
        People on this project
        {members.length > 0 ? <span className="count-badge">{members.length}</span> : null}
      </h4>

      {members.length === 0 ? (
        <p className="field-hint">Nobody yet. Only members can see this project&rsquo;s tasks.</p>
      ) : (
        <ul className="member-list">
          {members.map((member) => (
            <li key={member.user_id}>
              <span className="member-name">
                {member.display_name}
                {member.role === 'owner' ? <span className="chip chip-quiet">Owner</span> : null}
              </span>
              <span className="field-hint">{member.email_display}</span>
              {canManage ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${member.display_name}`}
                  onClick={() => void remove(member)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <div className="member-add">
          <PeoplePicker
            label="Add people"
            people={addable}
            selected={chosen}
            onChange={setChosen}
            emptyHint={
              addable.length === 0
                ? 'Everyone in the company is already on this project.'
                : 'Nobody selected yet.'
            }
          />
          {error ? <p className="field-error">{error}</p> : null}
          <div className="member-add-actions">
            <button
              type="button"
              className="ghost-button"
              disabled={busy || chosen.length === 0}
              onClick={() => void add()}
            >
              <UserPlus size={14} aria-hidden="true" />
              {busy ? ' Adding…' : ` Add ${chosen.length || ''}`.trimEnd()}
            </button>
          </div>
        </div>
      ) : null}

      {confirmElement}
    </section>
  );
}
