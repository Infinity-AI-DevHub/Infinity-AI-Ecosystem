/**
 * Clients, vendors and the guests who work with us (external collaboration).
 *
 * The screen is organised around the question a reviewer actually asks: not "who has an
 * account" but "who outside this company can reach our things, and what exactly". So a
 * guest's grants are shown alongside them rather than buried a level down, and access
 * expiry is displayed as prominently as their name.
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Building2, ShieldOff, UserPlus } from 'lucide-react';
import { api, idempotencyKey } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, Empty, FormError } from '../components/States';
import { formatDateTime, initials, relativeTime, titleCase } from '../lib/format';
import { useSession } from '../lib/session';

type Organization = {
  id: string;
  name: string;
  kind: string;
  status: string;
  website: string | null;
  notes: string | null;
  guest_count: number;
  created_at: string;
};

type Guest = {
  id: string;
  email: string;
  display_name: string;
  status: string;
  organization_id: string;
  organization_name: string;
  role_label: string | null;
  access_expires_at: string | null;
};

type Grant = {
  id: string;
  resource_type: string;
  resource_id: string;
  capabilities: string[];
  expires_at: string | null;
  created_at: string;
};

/** Access that has run out, or is about to, is the thing worth noticing on this screen. */
function expiryTone(value: string | null): { label: string; tone: string } {
  if (!value) return { label: 'No end date', tone: 'status-important' };
  const ends = new Date(value).getTime();
  const days = Math.round((ends - Date.now()) / 86_400_000);
  if (days < 0) return { label: 'Expired', tone: 'status-suspended' };
  if (days <= 14) return { label: `Ends in ${days} day${days === 1 ? '' : 's'}`, tone: 'status-invited' };
  return { label: `Until ${formatDateTime(value).split(',')[0]}`, tone: 'status-tag' };
}

export default function Clients() {
  const { organizationId } = useParams();
  const navigate = useNavigate();
  const { can } = useSession();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [inviting, setInviting] = useState(false);

  const listKey = `/external/organizations${search ? `?q=${encodeURIComponent(search)}` : ''}`;
  const organizations = useQuery<{ items: Organization[] }>(listKey, (signal) =>
    api.get(listKey, signal),
  );

  const selected = organizations.data?.items.find((o) => o.id === organizationId) ?? null;

  const guestKey = organizationId ? `/external/guests?organizationId=${organizationId}` : null;
  const guests = useQuery<{ items: Guest[] }>(guestKey, (signal) => api.get(guestKey!, signal));

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Clients</h2>
          <p>The organisations we work with, and everyone outside the company who can reach our work.</p>
        </div>
        {can('external_org.manage') ? (
          <button type="button" className="primary-button" onClick={() => setCreating(true)}>
            <Building2 size={15} aria-hidden="true" /> Add organisation
          </button>
        ) : null}
      </header>

      <div className="filter-row">
        <div className="field">
          <label htmlFor="client-search">Search</label>
          <input
            id="client-search"
            type="search"
            value={search}
            placeholder="Organisation name"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      <div className="split-layout">
        <section className="panel" aria-label="Organisations">
          <AsyncSection query={organizations}>
            {(data) =>
              data.items.length === 0 ? (
                <Empty
                  title="No organisations yet"
                  description="Add a client or vendor before inviting anyone from it."
                />
              ) : (
                <ul className="person-list">
                  {data.items.map((org) => (
                    <li key={org.id}>
                      <button
                        type="button"
                        className={`person-row ${org.id === organizationId ? 'person-active' : ''}`}
                        onClick={() => navigate(`/clients/${org.id}`)}
                      >
                        <span className="person-avatar" aria-hidden="true">
                          {initials(org.name)}
                        </span>
                        <span className="person-body">
                          <strong>{org.name}</strong>
                          <span>
                            {titleCase(org.kind)} · {org.guest_count} guest
                            {Number(org.guest_count) === 1 ? '' : 's'}
                          </span>
                        </span>
                        <span className={`status-tag status-${org.status}`}>
                          {titleCase(org.status)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </AsyncSection>
        </section>

        <section className="panel" aria-label="Organisation detail">
          {!selected ? (
            <Empty
              title="Select an organisation"
              description="Choose a client or vendor to see who from it can reach our work."
            />
          ) : (
            <article>
              <div className="panel-header">
                <div>
                  <h3>{selected.name}</h3>
                </div>
                {can('guest.manage') ? (
                  <button type="button" className="ghost-button" onClick={() => setInviting(true)}>
                    <UserPlus size={15} aria-hidden="true" /> Invite guest
                  </button>
                ) : null}
              </div>

              <dl className="detail-list">
                <div>
                  <dt>Relationship</dt>
                  <dd>{titleCase(selected.kind)}</dd>
                </div>
                {selected.website ? (
                  <div>
                    <dt>Website</dt>
                    <dd>{selected.website}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Added</dt>
                  <dd>
                    <time dateTime={selected.created_at}>{relativeTime(selected.created_at)}</time>
                  </dd>
                </div>
              </dl>

              {selected.notes ? <p className="meeting-agenda">{selected.notes}</p> : null}

              <h4>Guests</h4>
              <AsyncSection query={guests}>
                {(data) =>
                  data.items.length === 0 ? (
                    <p className="panel-empty">
                      Nobody from {selected.name} has access. Inviting a guest gives them an
                      account here — they still reach nothing until something is shared with
                      them.
                    </p>
                  ) : (
                    <ul className="guest-list">
                      {data.items.map((guest) => (
                        <GuestRow key={guest.id} guest={guest} canManage={can('guest.manage')} />
                      ))}
                    </ul>
                  )
                }
              </AsyncSection>
            </article>
          )}
        </section>
      </div>

      {creating ? (
        <OrganizationDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            invalidate('/external/organizations');
            navigate(`/clients/${id}`);
          }}
        />
      ) : null}

      {inviting && selected ? (
        <InviteGuestDialog
          organization={selected}
          onClose={() => setInviting(false)}
          onDone={() => {
            setInviting(false);
            invalidate('/external/guests');
            invalidate('/external/organizations');
          }}
        />
      ) : null}
    </div>
  );
}

function GuestRow({ guest, canManage }: { guest: Guest; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const expiry = expiryTone(guest.access_expires_at);

  const grantsKey = open ? `/external/guests/${guest.id}/grants` : null;
  const grants = useQuery<{ items: Grant[] }>(grantsKey, (signal) => api.get(grantsKey!, signal));

  const revoke = useMutation(
    async () => api.post(`/external/guests/${guest.id}/revoke`, { reason: 'Access no longer needed' }),
    { invalidates: ['/external/guests'] },
  );

  return (
    <li className="guest-row">
      <button
        type="button"
        className="guest-summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="person-avatar" aria-hidden="true">{initials(guest.display_name)}</span>
        <span className="person-body">
          <strong>{guest.display_name}</strong>
          <span>{guest.role_label ? `${guest.role_label} · ` : ''}{guest.email}</span>
        </span>
        <span className={`status-tag ${expiry.tone}`}>{expiry.label}</span>
      </button>

      {open ? (
        <div className="guest-detail">
          <h5>What they can reach</h5>
          <AsyncSection query={grants}>
            {(data) =>
              data.items.length === 0 ? (
                <p className="field-hint">
                  Nothing. They can sign in, but no file, folder or conversation has been
                  shared with them yet.
                </p>
              ) : (
                <ul className="grant-list">
                  {data.items.map((grant) => (
                    <li key={grant.id}>
                      <span className="grant-type">{titleCase(grant.resource_type)}</span>
                      <code>{grant.resource_id.slice(0, 8)}</code>
                      <span className="grant-caps">
                        {(Array.isArray(grant.capabilities) ? grant.capabilities : []).join(', ')}
                      </span>
                      <span className="task-meta">
                        {grant.expires_at
                          ? `until ${formatDateTime(grant.expires_at).split(',')[0]}`
                          : 'no end date'}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            }
          </AsyncSection>

          {canManage && guest.status === 'active' ? (
            <>
              <button
                type="button"
                className="danger-button"
                disabled={revoke.pending}
                onClick={() => void revoke.mutate()}
              >
                <ShieldOff size={14} aria-hidden="true" /> Revoke all access
              </button>
              <p className="field-hint">
                Closes their sessions and expires every grant immediately.
              </p>
            </>
          ) : null}
          <FormError error={revoke.error} />
        </div>
      ) : null}
    </li>
  );
}

function OrganizationDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('client');
  const [website, setWebsite] = useState('');
  const [notes, setNotes] = useState('');

  const create = useMutation(
    async () =>
      api.post<Organization>('/external/organizations', {
        name,
        kind,
        website: website || null,
        notes: notes || null,
      }),
    { invalidates: ['/external/organizations'], onSuccess: (org) => onCreated(org.id) },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="org-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="org-title">Add an organisation</h3>
        <FormError error={create.error} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create.mutate();
          }}
        >
          <div className="field">
            <label htmlFor="org-name">Name</label>
            <input id="org-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          <div className="field">
            <label htmlFor="org-kind">Relationship</label>
            <select id="org-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {['client', 'vendor', 'partner', 'contractor'].map((k) => (
                <option key={k} value={k}>{titleCase(k)}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="org-website">Website</label>
            <input id="org-website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" />
          </div>
          <div className="field">
            <label htmlFor="org-notes">Notes</label>
            <textarea id="org-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={create.pending || !name.trim()}>
              {create.pending ? 'Adding…' : 'Add organisation'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function InviteGuestDialog({
  organization,
  onClose,
  onDone,
}: {
  organization: Organization;
  onClose: () => void;
  onDone: () => void;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roleLabel, setRoleLabel] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [invitationUrl, setInvitationUrl] = useState<string | null>(null);
  const key = useMemo(() => idempotencyKey(), []);

  const invite = useMutation(
    async () =>
      api.post<{ invitationUrl: string }>(
        '/external/guests',
        {
          organizationId: organization.id,
          email,
          displayName,
          roleLabel: roleLabel || null,
          accessExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        },
        { idempotencyKey: key },
      ),
    { invalidates: ['/external/guests'], onSuccess: (r) => setInvitationUrl(r.invitationUrl) },
  );

  if (invitationUrl) {
    return (
      <div className="dialog-scrim" role="presentation" onClick={onDone}>
        <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="guest-done" onClick={(e) => e.stopPropagation()}>
          <h3 id="guest-done">Guest invited</h3>
          <p className="field-hint">
            Send them this activation link. They can sign in once they set a password — and
            will still see nothing until you share something with them.
          </p>
          <code className="invitation-link">{invitationUrl}</code>
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={() => navigator.clipboard?.writeText(invitationUrl)}>
              Copy link
            </button>
            <button type="button" className="primary-button" onClick={onDone}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="guest-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="guest-title">Invite someone from {organization.name}</h3>
        <p className="field-hint">
          Guests use their own work address. They are not colleagues: they never appear in
          the directory and reach only what you share with them.
        </p>
        <FormError error={invite.error} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void invite.mutate();
          }}
        >
          <div className="field">
            <label htmlFor="guest-email">Their work email</label>
            <input id="guest-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <div className="field">
            <label htmlFor="guest-name">Full name</label>
            <input id="guest-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="guest-role">Their role</label>
            <input id="guest-role" value={roleLabel} onChange={(e) => setRoleLabel(e.target.value)} placeholder="Project lead" />
          </div>
          <div className="field">
            <label htmlFor="guest-expiry">Access ends</label>
            <input id="guest-expiry" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            <p className="field-hint">
              Leave blank for 90 days. Access that never ends is how a finished engagement
              becomes a permanent way in.
            </p>
          </div>
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={invite.pending}>
              {invite.pending ? 'Inviting…' : 'Invite guest'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
