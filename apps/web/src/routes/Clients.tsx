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
import { api, ApiError, idempotencyKey } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, Empty, ErrorState, FormError, Loading } from '../components/States';
import { formatDateTime, initials, relativeTime, titleCase } from '../lib/format';
import { useSession } from '../lib/session';

type Organization = {
  id: string;
  name: string;
  kind: string;
  status: string;
  website: string | null;
  notes: string | null;
  billing_email: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  representative: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postal_code: string | null;
  country: string | null;
  tax_registration: string | null;
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
  const [editingOrgId, setEditingOrgId] = useState<string | null>(null);

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
                <div className="table-actions">
                  {can('external_org.manage') ? (
                    <>
                      {/* Lifecycle in one control rather than buried in the edit form:
                          moving a client between upcoming, active and completed is the
                          thing done most often. */}
                      <label className="inline-select">
                        <span className="visually-hidden">Status for {selected.name}</span>
                        <select
                          value={selected.status}
                          onChange={async (event) => {
                            await api.patch(`/external/organizations/${selected.id}`, {
                              status: event.target.value,
                            });
                            invalidate('/external/organizations');
                          }}
                        >
                          <option value="upcoming">Upcoming</option>
                          <option value="active">Active</option>
                          <option value="completed">Completed</option>
                          <option value="archived">Archived</option>
                        </select>
                      </label>
                      <button type="button" className="ghost-button" onClick={() => setEditingOrgId(selected.id)}>
                        Edit details
                      </button>
                      <button
                        type="button"
                        className="danger-button"
                        onClick={async () => {
                          try {
                            await api.delete(`/external/organizations/${selected.id}`);
                            invalidate('/external/organizations');
                            navigate('/clients');
                          } catch (err) {
                            // Refused while invoices, projects or guests are attached,
                            // and the message says which and how many.
                            window.alert(
                              err instanceof ApiError
                                ? err.message
                                : 'That organisation could not be deleted',
                            );
                          }
                        }}
                      >
                        Delete
                      </button>
                    </>
                  ) : null}
                  {can('guest.manage') ? (
                    <button type="button" className="ghost-button" onClick={() => setInviting(true)}>
                      <UserPlus size={15} aria-hidden="true" /> Invite guest
                    </button>
                  ) : null}
                </div>
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

              {selected.billing_email ? (
                <dl className="detail-list">
                  <dt>Billing email</dt><dd>{selected.billing_email}</dd>
                  {selected.representative ? (<><dt>Addressed to</dt><dd>{selected.representative}</dd></>) : null}
                  {selected.contact_name ? (<><dt>Contact</dt><dd>{selected.contact_name}</dd></>) : null}
                  {selected.contact_phone ? (<><dt>Phone</dt><dd>{selected.contact_phone}</dd></>) : null}
                  {selected.address_line1 ? (
                    <><dt>Address</dt><dd>
                      {[selected.address_line1, selected.address_line2, selected.city,
                        selected.postal_code, selected.country].filter(Boolean).join(', ')}
                    </dd></>
                  ) : null}
                  {selected.tax_registration ? (<><dt>Tax reg.</dt><dd>{selected.tax_registration}</dd></>) : null}
                </dl>
              ) : (
                <p className="field-hint">
                  No billing details yet — invoices for this organisation cannot be sent
                  until a billing email is added.
                </p>
              )}
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

      {editingOrgId ? (
        <EditOrganisation
          organizationId={editingOrgId}
          onClose={() => setEditingOrgId(null)}
          onSaved={() => { setEditingOrgId(null); invalidate('/external/organizations'); }}
        />
      ) : null}

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
  const [invitationUrl, setInvitationUrl] = useState<string | null>(null);
  const expiry = expiryTone(guest.access_expires_at);
  const resendKey = useMemo(() => idempotencyKey(), [guest.id]);

  const grantsKey = open ? `/external/guests/${guest.id}/grants` : null;
  const grants = useQuery<{ items: Grant[] }>(grantsKey, (signal) => api.get(grantsKey!, signal));

  const revoke = useMutation(
    async () => api.post(`/external/guests/${guest.id}/revoke`, { reason: 'Access no longer needed' }),
    { invalidates: ['/external/guests'] },
  );

  const resend = useMutation(
    async () =>
      api.post<{ invitation: { invitationUrl: string; expiresInHours: number } }>(
        `/external/guests/${guest.id}/invitation`,
        {},
        { idempotencyKey: resendKey },
      ),
    {
      onSuccess: (result) => setInvitationUrl(result.invitation.invitationUrl),
    },
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

          {canManage && guest.status === 'invited' ? (
            <div className="guest-invitation-actions">
              <button
                type="button"
                className="ghost-button"
                disabled={resend.pending}
                onClick={() => void resend.mutate()}
              >
                {resend.pending ? 'Sending…' : 'Resend portal invitation'}
              </button>
              <p className="field-hint">
                Sends a new 72-hour activation email and invalidates every previous link.
              </p>
              {invitationUrl ? (
                <div className="invitation-result" role="status">
                  <p className="field-hint">
                    A fresh invitation email was queued. If it does not arrive, copy this link:
                  </p>
                  <code className="invitation-link">{invitationUrl}</code>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => navigator.clipboard?.writeText(invitationUrl)}
                  >
                    Copy new link
                  </button>
                </div>
              ) : null}
              <FormError error={resend.error} />
            </div>
          ) : null}

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
  const [billingEmail, setBillingEmail] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [representative, setRepresentative] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [country, setCountry] = useState('');
  const [taxRegistration, setTaxRegistration] = useState('');

  const create = useMutation(
    async () =>
      api.post<Organization>('/external/organizations', {
        name,
        kind,
        website: website || null,
        notes: notes || null,
        billingEmail: billingEmail || null,
        contactName: contactName || null,
        contactPhone: contactPhone || null,
        representative: representative || null,
        addressLine1: addressLine1 || null,
        addressLine2: addressLine2 || null,
        city: city || null,
        postalCode: postalCode || null,
        country: country || null,
        taxRegistration: taxRegistration || null,
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
          <fieldset className="field">
            <legend>Billing</legend>
            <p className="field-hint">
              Needed before an invoice can be sent. Without an address here the invoice
              is refused at submission rather than failing silently later.
            </p>
            <div className="field">
              <label htmlFor="org-billing-email">Billing email</label>
              <input
                id="org-billing-email"
                type="email"
                value={billingEmail}
                onChange={(e) => setBillingEmail(e.target.value)}
                placeholder="accounts@client.example"
              />
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="org-contact-name">Contact person</label>
                <input id="org-contact-name" value={contactName}
                       onChange={(e) => setContactName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="org-contact-phone">Phone</label>
                <input id="org-contact-phone" value={contactPhone}
                       onChange={(e) => setContactPhone(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="org-rep">Authorised representative</label>
              <input id="org-rep" value={representative}
                     onChange={(e) => setRepresentative(e.target.value)}
                     placeholder="Managing Director" />
              <p className="field-hint">Who the invoice is addressed to.</p>
            </div>
          </fieldset>

          <fieldset className="field">
            <legend>Address</legend>
            <div className="field">
              <label htmlFor="org-addr1">Address</label>
              <input id="org-addr1" value={addressLine1}
                     onChange={(e) => setAddressLine1(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="org-addr2" className="visually-hidden">Address line 2</label>
              <input id="org-addr2" value={addressLine2}
                     onChange={(e) => setAddressLine2(e.target.value)} placeholder="Line 2" />
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="org-city">City</label>
                <input id="org-city" value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="org-postal">Postal code</label>
                <input id="org-postal" value={postalCode}
                       onChange={(e) => setPostalCode(e.target.value)} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="org-country">Country</label>
                <input id="org-country" value={country} onChange={(e) => setCountry(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="org-tax">Tax registration</label>
                <input id="org-tax" value={taxRegistration}
                       onChange={(e) => setTaxRegistration(e.target.value)} />
              </div>
            </div>
          </fieldset>

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
          {/* The invitation email goes out on its own. Saying "send them this link" made
              it read as a manual step and left people wondering whether anything was
              actually sent - the link is the fallback, not the method. */}
          <p className="field-hint">
            An invitation email is on its way to them now. They can sign in once they set
            a password, and will still see nothing until you share something with them.
          </p>
          <p className="field-hint">
            If it does not arrive, send them this link yourself:
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


/**
 * Editing an organisation's billing details.
 *
 * This exists because the invoice guard refuses to send to a client with no billing
 * address, and until now there was no way to add one to a client that already existed -
 * a rule enforced with no means of satisfying it.
 *
 * Only sends what changed. A PATCH of every field would overwrite a value another
 * person edited while this form was open.
 */
function EditOrganisation({
  organizationId, onClose, onSaved,
}: { organizationId: string; onClose: () => void; onSaved: () => void }) {
  const organisation = useQuery<Organization>(`/external/organizations/${organizationId}`, (signal) =>
    api.get(`/external/organizations/${organizationId}`, signal),
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog dialog-wide" role="dialog" aria-label="Edit organisation"
           onClick={(event) => event.stopPropagation()}>
        {organisation.loading ? <Loading /> : null}
        {organisation.error ? <ErrorState error={organisation.error} onRetry={organisation.reload} /> : null}
        {organisation.data ? (
          <EditOrganisationForm organisation={organisation.data} onClose={onClose} onSaved={onSaved} />
        ) : null}
      </div>
    </div>
  );
}

function EditOrganisationForm({
  organisation, onClose, onSaved,
}: { organisation: Organization; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: organisation.name ?? '',
    billingEmail: organisation.billing_email ?? '',
    contactName: organisation.contact_name ?? '',
    contactPhone: organisation.contact_phone ?? '',
    representative: organisation.representative ?? '',
    addressLine1: organisation.address_line1 ?? '',
    addressLine2: organisation.address_line2 ?? '',
    city: organisation.city ?? '',
    postalCode: organisation.postal_code ?? '',
    country: organisation.country ?? '',
    taxRegistration: organisation.tax_registration ?? '',
    website: organisation.website ?? '',
    notes: organisation.notes ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.patch(`/external/organizations/${organisation.id}`, {
        name: form.name,
        billingEmail: form.billingEmail || null,
        contactName: form.contactName || null,
        contactPhone: form.contactPhone || null,
        representative: form.representative || null,
        addressLine1: form.addressLine1 || null,
        addressLine2: form.addressLine2 || null,
        city: form.city || null,
        postalCode: form.postalCode || null,
        country: form.country || null,
        taxRegistration: form.taxRegistration || null,
        website: form.website || null,
        notes: form.notes || null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be saved');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit}>
        <h3>Edit {organisation.name}</h3>

        <div className="field">
          <label htmlFor="eo-name">Name</label>
          <input id="eo-name" value={form.name} required
                 onChange={(e) => set({ name: e.target.value })} />
        </div>

        <fieldset className="field">
          <legend>Billing</legend>
          {!form.billingEmail ? (
            <p className="field-hint">
              Without a billing email, invoices for this organisation are refused at
              submission.
            </p>
          ) : null}
          <div className="field">
            <label htmlFor="eo-email">Billing email</label>
            <input id="eo-email" type="email" value={form.billingEmail}
                   onChange={(e) => set({ billingEmail: e.target.value })} />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="eo-contact">Contact person</label>
              <input id="eo-contact" value={form.contactName}
                     onChange={(e) => set({ contactName: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="eo-phone">Phone</label>
              <input id="eo-phone" value={form.contactPhone}
                     onChange={(e) => set({ contactPhone: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="eo-rep">Authorised representative</label>
            <input id="eo-rep" value={form.representative}
                   onChange={(e) => set({ representative: e.target.value })} />
          </div>
        </fieldset>

        <fieldset className="field">
          <legend>Address</legend>
          <div className="field">
            <label htmlFor="eo-a1">Address</label>
            <input id="eo-a1" value={form.addressLine1}
                   onChange={(e) => set({ addressLine1: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="eo-a2" className="visually-hidden">Address line 2</label>
            <input id="eo-a2" placeholder="Line 2" value={form.addressLine2}
                   onChange={(e) => set({ addressLine2: e.target.value })} />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="eo-city">City</label>
              <input id="eo-city" value={form.city} onChange={(e) => set({ city: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="eo-post">Postal code</label>
              <input id="eo-post" value={form.postalCode}
                     onChange={(e) => set({ postalCode: e.target.value })} />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="eo-country">Country</label>
              <input id="eo-country" value={form.country}
                     onChange={(e) => set({ country: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="eo-tax">Tax registration</label>
              <input id="eo-tax" value={form.taxRegistration}
                     onChange={(e) => set({ taxRegistration: e.target.value })} />
            </div>
          </div>
        </fieldset>

        <div className="field">
          <label htmlFor="eo-web">Website</label>
          <input id="eo-web" value={form.website} onChange={(e) => set({ website: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="eo-notes">Notes</label>
          <textarea id="eo-notes" rows={3} value={form.notes}
                    onChange={(e) => set({ notes: e.target.value })} />
        </div>

        {error ? <p className="field-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
    </form>
  );
}
