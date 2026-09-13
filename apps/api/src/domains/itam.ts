/**
 * IT asset management beyond the asset register: software licences, vendor contracts,
 * and the reminders that keep warranties, renewals and contract notice periods from
 * lapsing unnoticed.
 *
 * Assets and vendors themselves stay in the finance domain where they were built; this
 * module reads them rather than keeping a second copy.
 *
 * Licence keys are not stored anywhere in this module. `managed_at` records where the key
 * lives instead. A key is a credential, and credential storage is the separately reviewed
 * secrets-vault milestone.
 */
import { many, newId, one, pool, transaction } from '../core/db.js';
import { conflict, notFound, unprocessable } from '../core/errors.js';
import { authorize, hasCapability, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import * as notifications from './notifications.js';

const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : null);

async function assertVendor(companyId: string, vendorId: string | null | undefined) {
  if (vendorId && !(await one('SELECT 1 FROM vendors WHERE id = $1 AND company_id = $2', [vendorId, companyId]))) {
    throw unprocessable('Vendor not found', [{ field: 'vendorId', message: 'Choose a vendor' }]);
  }
}
async function assertEmployee(companyId: string, userId: string | null | undefined, field: string) {
  if (userId && !(await one("SELECT 1 FROM users WHERE id = $1 AND company_id = $2 AND access_level <> 'guest'", [userId, companyId]))) {
    throw unprocessable('Person not found', [{ field, message: 'Choose an employee' }]);
  }
}

/* ---------------------------------------------------------------- licences */

type LicenceInput = {
  name: string; vendorId?: string | null; licenceType?: 'subscription' | 'perpetual' | 'open_source' | 'trial';
  seats?: number | null; cost?: number | null; currency?: string; billingPeriod?: 'monthly' | 'yearly' | 'one_off' | null;
  renewsOn?: string | null; managedAt?: string | null; ownerId?: string | null; status?: 'active' | 'expired' | 'cancelled'; notes?: string | null;
};

export async function listLicences(actor: Actor, filter: { status?: string; q?: string }) {
  await authorize({ actor, capability: 'licence.read', resourceless: true });
  const where = ['l.company_id = $1'];
  const params: unknown[] = [actor.companyId];
  if (filter.status) { params.push(filter.status); where.push(`l.status = $${params.length}`); }
  if (filter.q) { params.push(`%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); where.push(`l.name LIKE $${params.length}`); }
  const rows = await many<Record<string, unknown>>(
    `SELECT l.id, l.name, l.vendor_id, v.name AS vendor_name, l.licence_type, l.seats, l.cost, l.currency, l.billing_period,
            DATE_FORMAT(l.renews_on, '%Y-%m-%d') AS renews_on, l.managed_at, l.owner_id, o.display_name AS owner_name,
            l.status, l.notes, (SELECT COUNT(*) FROM licence_assignments a WHERE a.licence_id = l.id) AS used
       FROM software_licences l LEFT JOIN vendors v ON v.id = l.vendor_id LEFT JOIN users o ON o.id = l.owner_id
      WHERE ${where.join(' AND ')}
      ORDER BY (l.renews_on IS NULL), l.renews_on, l.name`,
    params,
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, vendorId: r.vendor_id, vendorName: r.vendor_name, licenceType: r.licence_type,
    seats: r.seats === null ? null : Number(r.seats), used: Number(r.used), cost: r.cost === null ? null : Number(r.cost),
    currency: r.currency, billingPeriod: r.billing_period, renewsOn: r.renews_on, managedAt: r.managed_at,
    ownerId: r.owner_id, ownerName: r.owner_name, status: r.status, notes: r.notes,
  }));
}

export async function saveLicence(actor: Actor, id: string | null, input: LicenceInput) {
  await authorize({ actor, capability: 'licence.manage', resourceless: true });
  await assertVendor(actor.companyId, input.vendorId);
  await assertEmployee(actor.companyId, input.ownerId, 'ownerId');
  if (id) {
    const existing = await one<{ seats: number | null }>('SELECT seats FROM software_licences WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
    if (!existing) throw notFound('Licence not found');
    if (input.seats !== undefined && input.seats !== null) {
      const used = await one<{ n: number }>('SELECT COUNT(*) AS n FROM licence_assignments WHERE licence_id = $1', [id]);
      if (Number(used?.n ?? 0) > input.seats) throw conflict(`${used!.n} people hold this licence; release seats before reducing it to ${input.seats}`);
    }
  }
  const licenceId = id ?? newId();
  const values = [licenceId, actor.companyId, input.name.trim(), input.vendorId ?? null, input.licenceType ?? 'subscription', input.seats ?? null,
    input.cost ?? null, (input.currency ?? 'USD').toUpperCase(), input.billingPeriod ?? null, day(input.renewsOn), input.managedAt?.trim() || null,
    input.ownerId ?? null, input.status ?? 'active', input.notes?.trim() || null, actor.userId];
  if (id) {
    await pool.query(
      `UPDATE software_licences SET name = $3, vendor_id = $4, licence_type = $5, seats = $6, cost = $7, currency = $8,
         billing_period = $9, renews_on = $10, managed_at = $11, owner_id = $12, status = $13, notes = $14
       WHERE id = $1 AND company_id = $2`, values.slice(0, 14));
  } else {
    await pool.query(
      `INSERT INTO software_licences (id, company_id, name, vendor_id, licence_type, seats, cost, currency, billing_period,
         renews_on, managed_at, owner_id, status, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, values);
  }
  await auditFromActor(actor, id ? 'licence.update' : 'licence.create', { resourceType: 'software_licence', resourceId: licenceId, metadata: { name: input.name } });
  return { id: licenceId };
}

export async function licenceHolders(actor: Actor, id: string) {
  await authorize({ actor, capability: 'licence.read', resourceless: true });
  if (!(await one('SELECT 1 FROM software_licences WHERE id = $1 AND company_id = $2', [id, actor.companyId]))) throw notFound('Licence not found');
  return many<{ id: string; display_name: string; email: string; status: string; assigned_at: Date }>(
    `SELECT u.id, u.display_name, u.email, u.status, a.assigned_at FROM licence_assignments a JOIN users u ON u.id = a.user_id
      WHERE a.licence_id = $1 ORDER BY u.display_name`, [id]);
}

export async function assignLicence(actor: Actor, id: string, userId: string, release = false) {
  await authorize({ actor, capability: 'licence.manage', resourceless: true });
  await assertEmployee(actor.companyId, userId, 'userId');
  await transaction(async (tx) => {
    const lic = (await tx.query<{ seats: number | null; name: string }>('SELECT seats, name FROM software_licences WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, actor.companyId])).rows[0];
    if (!lic) throw notFound('Licence not found');
    if (release) {
      await tx.query('DELETE FROM licence_assignments WHERE licence_id = $1 AND user_id = $2', [id, userId]);
    } else {
      const used = (await tx.query<{ n: number }>('SELECT COUNT(*) AS n FROM licence_assignments WHERE licence_id = $1', [id])).rows[0];
      if (lic.seats !== null && Number(used?.n ?? 0) >= lic.seats) throw conflict(lic.seats === 1 ? `The only seat of ${lic.name} is in use` : `All ${lic.seats} seats of ${lic.name} are in use`);
      await tx.query('INSERT IGNORE INTO licence_assignments (licence_id, user_id, company_id, assigned_by) VALUES ($1,$2,$3,$4)', [id, userId, actor.companyId, actor.userId]);
    }
    await auditFromActor(actor, release ? 'licence.release' : 'licence.assign', { resourceType: 'software_licence', resourceId: id, metadata: { userId } }, tx);
  });
  return { items: await licenceHolders(actor, id) };
}

/** Licences someone holds - used when they leave, so seats are reclaimed. */
export async function licencesHeldBy(actor: Actor, userId: string) {
  await authorize({ actor, capability: 'licence.read', resourceless: true });
  return many<{ id: string; name: string }>(
    `SELECT l.id, l.name FROM licence_assignments a JOIN software_licences l ON l.id = a.licence_id
      WHERE a.user_id = $1 AND a.company_id = $2 ORDER BY l.name`, [userId, actor.companyId]);
}

/* --------------------------------------------------------------- contracts */

type ContractInput = {
  vendorId: string; title: string; reference?: string | null; startsOn?: string | null; endsOn?: string | null;
  noticeDays?: number; autoRenews?: boolean; value?: number | null; currency?: string; ownerId?: string | null;
  documentFileId?: string | null; status?: 'active' | 'ended' | 'cancelled'; notes?: string | null;
};

export async function listContracts(actor: Actor, filter: { status?: string; vendorId?: string }) {
  await authorize({ actor, capability: 'licence.read', resourceless: true });
  const where = ['c.company_id = $1'];
  const params: unknown[] = [actor.companyId];
  if (filter.status) { params.push(filter.status); where.push(`c.status = $${params.length}`); }
  if (filter.vendorId) { params.push(filter.vendorId); where.push(`c.vendor_id = $${params.length}`); }
  const rows = await many<Record<string, unknown>>(
    `SELECT c.id, c.vendor_id, v.name AS vendor_name, c.title, c.reference, DATE_FORMAT(c.starts_on, '%Y-%m-%d') AS starts_on,
            DATE_FORMAT(c.ends_on, '%Y-%m-%d') AS ends_on, c.notice_days, c.auto_renews, c.value, c.currency,
            c.owner_id, o.display_name AS owner_name, c.document_file_id, f.name AS document_name, c.status, c.notes,
            DATE_FORMAT(DATE_SUB(c.ends_on, INTERVAL c.notice_days DAY), '%Y-%m-%d') AS notice_by
       FROM vendor_contracts c JOIN vendors v ON v.id = c.vendor_id
       LEFT JOIN users o ON o.id = c.owner_id LEFT JOIN files f ON f.id = c.document_file_id AND f.state = 'active'
      WHERE ${where.join(' AND ')}
      ORDER BY (c.ends_on IS NULL), c.ends_on, c.title`,
    params,
  );
  return rows.map((r) => ({
    id: r.id, vendorId: r.vendor_id, vendorName: r.vendor_name, title: r.title, reference: r.reference,
    startsOn: r.starts_on, endsOn: r.ends_on, noticeDays: Number(r.notice_days), noticeBy: r.notice_by,
    autoRenews: Boolean(r.auto_renews), value: r.value === null ? null : Number(r.value), currency: r.currency,
    ownerId: r.owner_id, ownerName: r.owner_name, documentFileId: r.document_file_id, documentName: r.document_name,
    status: r.status, notes: r.notes,
  }));
}

export async function saveContract(actor: Actor, id: string | null, input: ContractInput) {
  await authorize({ actor, capability: 'licence.manage', resourceless: true });
  await assertVendor(actor.companyId, input.vendorId);
  await assertEmployee(actor.companyId, input.ownerId, 'ownerId');
  if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) {
    throw unprocessable('The contract ends before it starts', [{ field: 'endsOn', message: 'End after the start' }]);
  }
  // Only a document this person uploaded, so attaching one cannot become a way to reach a
  // file in a folder they could not open. Downloads are then authorised by the contract.
  if (input.documentFileId) {
    const file = await one<{ owner_id: string | null }>("SELECT owner_id FROM files WHERE id = $1 AND company_id = $2 AND state = 'active'", [input.documentFileId, actor.companyId]);
    if (!file || file.owner_id !== actor.userId) {
      throw unprocessable('Document not found', [{ field: 'documentFileId', message: 'Upload the document first' }]);
    }
  }
  if (id && !(await one('SELECT 1 FROM vendor_contracts WHERE id = $1 AND company_id = $2', [id, actor.companyId]))) throw notFound('Contract not found');
  const contractId = id ?? newId();
  const values = [contractId, actor.companyId, input.vendorId, input.title.trim(), input.reference?.trim() || null, day(input.startsOn), day(input.endsOn),
    input.noticeDays ?? 30, Boolean(input.autoRenews), input.value ?? null, (input.currency ?? 'USD').toUpperCase(), input.ownerId ?? null,
    input.documentFileId ?? null, input.status ?? 'active', input.notes?.trim() || null, actor.userId];
  if (id) {
    await pool.query(
      `UPDATE vendor_contracts SET vendor_id = $3, title = $4, reference = $5, starts_on = $6, ends_on = $7, notice_days = $8,
         auto_renews = $9, value = $10, currency = $11, owner_id = $12, document_file_id = $13, status = $14, notes = $15
       WHERE id = $1 AND company_id = $2`, values.slice(0, 15));
  } else {
    await pool.query(
      `INSERT INTO vendor_contracts (id, company_id, vendor_id, title, reference, starts_on, ends_on, notice_days, auto_renews, value,
         currency, owner_id, document_file_id, status, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, values);
  }
  await auditFromActor(actor, id ? 'contract.update' : 'contract.create', { resourceType: 'vendor_contract', resourceId: contractId, metadata: { title: input.title } });
  return { id: contractId };
}

export async function contractDocument(actor: Actor, id: string) {
  await authorize({ actor, capability: 'licence.read', resourceless: true });
  const c = await one<{ document_file_id: string | null }>('SELECT document_file_id FROM vendor_contracts WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!c?.document_file_id) throw notFound('This contract has no document');
  const { signedDownloadForShare } = await import('./files.js');
  const link = await signedDownloadForShare(c.document_file_id);
  await auditFromActor(actor, 'contract.document.download', { resourceType: 'vendor_contract', resourceId: id });
  return link;
}

/* --------------------------------------------------------------- overview */

/** What is about to lapse in the next `days` days: warranties, renewals, notice deadlines. */
export async function expiring(actor: Actor, days: number) {
  await authorize({ actor, capability: 'licence.read', resourceless: true });
  const canAssets = hasCapability(actor, 'asset.read');
  const warranties = canAssets ? await many<{ id: string; asset_tag: string; name: string; warranty_until: string; holder: string | null }>(
    `SELECT a.id, a.asset_tag, a.name, DATE_FORMAT(a.warranty_until, '%Y-%m-%d') AS warranty_until, u.display_name AS holder
       FROM assets a LEFT JOIN users u ON u.id = a.assigned_to
      WHERE a.company_id = $1 AND a.status NOT IN ('retired','lost') AND a.warranty_until IS NOT NULL
        AND a.warranty_until BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL $2 DAY)
      ORDER BY a.warranty_until`, [actor.companyId, days]) : [];
  const renewals = await many<{ id: string; name: string; renews_on: string; cost: number | null; currency: string }>(
    `SELECT id, name, DATE_FORMAT(renews_on, '%Y-%m-%d') AS renews_on, cost, currency FROM software_licences
      WHERE company_id = $1 AND status = 'active' AND renews_on BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL $2 DAY)
      ORDER BY renews_on`, [actor.companyId, days]);
  const notices = await many<{ id: string; title: string; vendor_name: string; ends_on: string; notice_by: string; auto_renews: number }>(
    `SELECT c.id, c.title, v.name AS vendor_name, DATE_FORMAT(c.ends_on, '%Y-%m-%d') AS ends_on,
            DATE_FORMAT(DATE_SUB(c.ends_on, INTERVAL c.notice_days DAY), '%Y-%m-%d') AS notice_by, c.auto_renews
       FROM vendor_contracts c JOIN vendors v ON v.id = c.vendor_id
      WHERE c.company_id = $1 AND c.status = 'active' AND c.ends_on IS NOT NULL
        AND DATE_SUB(c.ends_on, INTERVAL c.notice_days DAY) <= DATE_ADD(CURDATE(), INTERVAL $2 DAY) AND c.ends_on >= CURDATE()
      ORDER BY notice_by`, [actor.companyId, days]);
  return {
    days,
    warranties: warranties.map((w) => ({ id: w.id, tag: w.asset_tag, name: w.name, date: w.warranty_until, holder: w.holder })),
    renewals: renewals.map((r) => ({ id: r.id, name: r.name, date: r.renews_on, cost: r.cost === null ? null : Number(r.cost), currency: r.currency })),
    contracts: notices.map((c) => ({ id: c.id, title: c.title, vendorName: c.vendor_name, endsOn: c.ends_on, noticeBy: c.notice_by, autoRenews: Boolean(c.auto_renews) })),
  };
}

/**
 * Scheduled: tells the owner (or the company's licence managers when there is none) at 30
 * and 7 days before a warranty ends, a licence renews, or a contract's notice deadline.
 * The dedupe key names the date and the threshold, so each reminder is sent once.
 */
export async function sendExpiryReminders(): Promise<number> {
  let sent = 0;
  const managers = async (companyId: string) => (await many<{ id: string }>(
    `SELECT u.id FROM users u JOIN role_capabilities rc ON rc.role = u.access_level AND rc.capability = 'licence.manage'
      WHERE u.company_id = $1 AND u.status = 'active'`, [companyId])).map((r) => r.id);
  const remind = async (companyId: string, ownerId: string | null, key: string, title: string, body: string, link: string) => {
    const targets = ownerId ? [ownerId] : await managers(companyId);
    for (const userId of targets) {
      if (await notifications.create({ companyId, userId, type: 'itam.expiry', title, body, link, dedupeKey: `${key}:${userId}` })) sent += 1;
    }
  };
  for (const threshold of [30, 7]) {
    const warranties = await many<{ id: string; company_id: string; asset_tag: string; name: string; d: string }>(
      `SELECT id, company_id, asset_tag, name, DATE_FORMAT(warranty_until, '%Y-%m-%d') AS d FROM assets
        WHERE status NOT IN ('retired','lost') AND warranty_until = DATE_ADD(CURDATE(), INTERVAL $1 DAY)`, [threshold]);
    for (const w of warranties) await remind(w.company_id, null, `warranty:${w.id}:${w.d}:${threshold}`, `Warranty ends in ${threshold} days: ${w.asset_tag}`, `${w.name} - ${w.d}`, '/service/assets?tab=expiring');
    const licences = await many<{ id: string; company_id: string; name: string; owner_id: string | null; d: string }>(
      `SELECT id, company_id, name, owner_id, DATE_FORMAT(renews_on, '%Y-%m-%d') AS d FROM software_licences
        WHERE status = 'active' AND renews_on = DATE_ADD(CURDATE(), INTERVAL $1 DAY)`, [threshold]);
    for (const l of licences) await remind(l.company_id, l.owner_id, `licence:${l.id}:${l.d}:${threshold}`, `${l.name} renews in ${threshold} days`, `Renewal date ${l.d}`, '/service/assets?tab=licences');
    const contracts = await many<{ id: string; company_id: string; title: string; owner_id: string | null; d: string }>(
      `SELECT id, company_id, title, owner_id, DATE_FORMAT(DATE_SUB(ends_on, INTERVAL notice_days DAY), '%Y-%m-%d') AS d FROM vendor_contracts
        WHERE status = 'active' AND ends_on IS NOT NULL AND DATE_SUB(ends_on, INTERVAL notice_days DAY) = DATE_ADD(CURDATE(), INTERVAL $1 DAY)`, [threshold]);
    for (const c of contracts) await remind(c.company_id, c.owner_id, `contract:${c.id}:${c.d}:${threshold}`, `Notice deadline in ${threshold} days: ${c.title}`, `Give notice by ${c.d} or the contract continues`, '/service/assets?tab=contracts');
  }
  return sent;
}
