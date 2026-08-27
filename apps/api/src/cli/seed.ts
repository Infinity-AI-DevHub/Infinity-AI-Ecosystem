/**
 * Seed script.
 *
 * Creates a company, its departments and rooms, an initial super administrator, the
 * default approval definitions, and - only outside production - a small set of synthetic
 * colleagues so the application can be explored end to end.
 *
 * Employee email lives in a separate application, so no mailboxes are provisioned here.
 *
 * Real employee data is never seeded. The blueprint requires piloting with synthetic
 * data before real people are loaded.
 */
import { randomUUID } from 'node:crypto';
import { closePool, newId, pool, transaction } from '../core/db.js';
import { logger } from '../core/logger.js';
import { config } from '../core/config.js';
import { generateToken, hashPassword, hashToken, generateTotpSecret, encryptField } from '../core/crypto.js';
import { migrate } from './migrate.js';

const COMPANY_NAME = process.env.SEED_COMPANY_NAME ?? 'Infinity Holdings';
const DOMAIN = (process.env.SEED_DOMAIN ?? config.notifications.defaultDomain).toLowerCase();
const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL ?? `admin@${DOMAIN}`).toLowerCase();
const ADMIN_NAME = process.env.SEED_ADMIN_NAME ?? 'Workspace Administrator';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? '';

const DEPARTMENTS = ['Executive', 'Finance', 'Operations', 'Engineering', 'People'];
const ROOMS = [
  { name: 'Boardroom', capacity: 14, location: 'Level 3' },
  { name: 'Focus Room A', capacity: 4, location: 'Level 2' },
  { name: 'Training Room', capacity: 30, location: 'Level 1' },
];

/** Approval routes: manager first, then finance above a threshold. */
const APPROVAL_DEFINITIONS = [
  {
    key: 'expense',
    name: 'Expense claim',
    formSchema: [
      { field: 'amount', label: 'Amount', type: 'currency', required: true },
      { field: 'category', label: 'Category', type: 'select', options: ['Travel', 'Equipment', 'Client', 'Other'] },
      { field: 'justification', label: 'Business justification', type: 'textarea', required: true },
    ],
    routing: [
      { step: 1, approver: { type: 'manager' }, dueHours: 48 },
      { step: 2, minAmount: 1000, approver: { type: 'access_level', value: 'admin' }, dueHours: 72 },
    ],
  },
  {
    key: 'leave',
    name: 'Leave request',
    formSchema: [
      { field: 'startDate', label: 'First day', type: 'date', required: true },
      { field: 'endDate', label: 'Last day', type: 'date', required: true },
      { field: 'type', label: 'Type', type: 'select', options: ['Annual', 'Sick', 'Unpaid', 'Parental'] },
    ],
    routing: [{ step: 1, approver: { type: 'manager' }, dueHours: 72 }],
  },
  {
    key: 'purchase',
    name: 'Purchase request',
    formSchema: [
      { field: 'amount', label: 'Amount', type: 'currency', required: true },
      { field: 'vendor', label: 'Vendor', type: 'text', required: true },
      { field: 'justification', label: 'Justification', type: 'textarea', required: true },
    ],
    routing: [
      { step: 1, approver: { type: 'manager' }, dueHours: 48 },
      { step: 2, minAmount: 5000, approver: { type: 'access_level', value: 'admin' }, dueHours: 72 },
    ],
  },
];

const SAMPLE_PEOPLE = [
  { name: 'Amara Perera', title: 'Chief Operating Officer', department: 'Executive', level: 'admin' },
  { name: 'Ishan Fernando', title: 'Finance Lead', department: 'Finance', level: 'manager' },
  { name: 'Nadia Rahman', title: 'Operations Manager', department: 'Operations', level: 'manager' },
  { name: 'Kavi Silva', title: 'Senior Engineer', department: 'Engineering', level: 'staff' },
  { name: 'Tomas Nowak', title: 'Site Coordinator', department: 'Operations', level: 'staff' },
  { name: 'Leah Gunawardena', title: 'People Partner', department: 'People', level: 'staff' },
  { name: 'Compliance Review', title: 'Internal Auditor', department: 'Executive', level: 'auditor' },
];

async function seed(): Promise<void> {
  await migrate();

  const result = await transaction(async (tx) => {
    // Company
    const newCompanyId = newId();
    const companyRes = await tx.query(
      `INSERT IGNORE INTO companies (id, name, verified_domains, settings)
       VALUES ($1,$2,$3,$4)`,
      [
        newCompanyId,
        COMPANY_NAME,
        JSON.stringify([DOMAIN]),
        JSON.stringify({ storageQuotaBytes: 1099511627776 }),
      ],
    );
    let companyId: string | undefined = companyRes.rowCount > 0 ? newCompanyId : undefined;
    if (!companyId) {
      const existing = await tx.query<{ id: string }>(
        'SELECT id FROM companies WHERE JSON_CONTAINS(verified_domains, JSON_QUOTE($1)) LIMIT 1',
        [DOMAIN],
      );
      companyId = existing.rows[0]?.id;
      if (!companyId) throw new Error('Could not create or find the company');
      logger.info({ companyId }, 'company already exists; reusing it');
    }

    // Departments
    const departmentIds = new Map<string, string>();
    for (const name of DEPARTMENTS) {
      const departmentId = newId();
      await tx.query(
        'INSERT IGNORE INTO departments (id, company_id, name) VALUES ($1,$2,$3)',
        [departmentId, companyId, name],
      );
      const row = await tx.query<{ id: string }>(
        'SELECT id FROM departments WHERE company_id = $1 AND name = $2',
        [companyId, name],
      );
      departmentIds.set(name, row.rows[0]!.id);
    }

    for (const room of ROOMS) {
      await tx.query(
        `INSERT IGNORE INTO rooms (id, company_id, name, capacity, location) VALUES ($1,$2,$3,$4,$5)`,
        [newId(), companyId, room.name, room.capacity, room.location],
      );
    }

    for (const definition of APPROVAL_DEFINITIONS) {
      await tx.query(
        `INSERT INTO approval_definitions (id, company_id, \`key\`, name, form_schema, routing)
         VALUES ($1,$2,$3,$4,$5,$6) AS incoming
         ON DUPLICATE KEY UPDATE
           name = incoming.name, form_schema = incoming.form_schema, routing = incoming.routing`,
        [
          newId(),
          companyId,
          definition.key,
          definition.name,
          JSON.stringify(definition.formSchema),
          JSON.stringify(definition.routing),
        ],
      );
    }

    // Super administrator
    const newAdminId = newId();
    const adminRes = await tx.query(
      `INSERT IGNORE INTO users
         (id, company_id, email, email_display, display_name, title, department_id,
          access_level, status, activated_at, modules)
       VALUES ($1,$2,$3,$4,$5,'Workspace Administrator',$6,'super_admin',
               CASE WHEN $7 = '' THEN 'invited' ELSE 'active' END,
               CASE WHEN $7 = '' THEN NULL ELSE NOW(3) END,
               JSON_ARRAY())`,
      [
        newAdminId,
        companyId,
        ADMIN_EMAIL,
        ADMIN_EMAIL,
        ADMIN_NAME,
        departmentIds.get('Executive'),
        ADMIN_PASSWORD,
      ],
    );

    let adminId: string | null = adminRes.rowCount > 0 ? newAdminId : null;
    let invitationToken: string | null = null;

    if (adminId) {
      if (ADMIN_PASSWORD) {
        // A password supplied by the operator sets up the account directly, with MFA
        // enrolled but not yet confirmed - the first login completes enrolment.
        const secret = generateTotpSecret();
        await tx.query(
          `INSERT INTO identities (user_id, password_hash, password_set_at, mfa_secret_enc, recovery_codes)
           VALUES ($1,$2,NOW(3),$3, JSON_ARRAY())`,
          [adminId, await hashPassword(ADMIN_PASSWORD), encryptField(secret)],
        );
      } else {
        // No password given: issue a normal single-use activation invitation instead of
        // inventing one. This is the path the blueprint requires.
        await tx.query(
          'INSERT INTO identities (user_id, recovery_codes) VALUES ($1, JSON_ARRAY())',
          [adminId],
        );
        invitationToken = generateToken();
        await tx.query(
          `INSERT INTO invitations (id, company_id, user_id, token_hash, expires_at)
           VALUES ($1,$2,$3,$4, DATE_ADD(NOW(3), INTERVAL 72 HOUR))`,
          [newId(), companyId, adminId, hashToken(invitationToken)],
        );
      }
    } else {
      const existing = await tx.query<{ id: string }>(
        'SELECT id FROM users WHERE company_id = $1 AND email = $2',
        [companyId, ADMIN_EMAIL],
      );
      adminId = existing.rows[0]?.id ?? null;
      logger.info('administrator already exists; leaving credentials untouched');
    }

    // Synthetic colleagues, development and staging only.
    const created: string[] = [];
    if (!config.isProd && adminId) {
      for (const person of SAMPLE_PEOPLE) {
        const email = `${person.name.toLowerCase().replace(/[^a-z]+/g, '.')}@${DOMAIN}`;
        const personId = newId();
        const res = await tx.query(
          `INSERT IGNORE INTO users
             (id, company_id, email, email_display, display_name, title, department_id,
              manager_id, access_level, status, activated_at, modules)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'invited',NULL, JSON_ARRAY())`,
          [
            personId,
            companyId,
            email,
            email,
            person.name,
            person.title,
            departmentIds.get(person.department),
            adminId,
            person.level,
          ],
        );
        if (res.rowCount === 0) continue;
        const userId = personId;
        await tx.query(
          'INSERT IGNORE INTO identities (user_id, recovery_codes) VALUES ($1, JSON_ARRAY())',
          [userId],
        );
        // Each seeded colleague gets a real, single-use invitation - never a shared password.
        const token = generateToken();
        await tx.query(
          `INSERT INTO invitations (id, company_id, user_id, token_hash, expires_at)
           VALUES ($1,$2,$3,$4, DATE_ADD(NOW(3), INTERVAL 72 HOUR))`,
          [newId(), companyId, userId, hashToken(token)],
        );
        created.push(`${person.name} <${email}> activation: ${config.publicUrl}/activate?token=${token}`);
      }

      // A company-wide channel and a starter project give the workspace somewhere to begin.
      const channelId = newId();
      const channel = await tx.query(
        `INSERT IGNORE INTO chat_rooms (id, company_id, type, name, topic, visibility, created_by)
         VALUES ($1,$2,'channel','general','Company-wide announcements and discussion','company',$3)`,
        [channelId, companyId, adminId],
      );
      if (channel.rowCount > 0) {
        await tx.query(`INSERT INTO chat_members (room_id, user_id, role) VALUES ($1,$2,'owner')`, [
          channelId,
          adminId,
        ]);
      }
      const projectId = newId();
      const project = await tx.query(
        `INSERT IGNORE INTO projects (id, company_id, name, \`key\`, description, owner_id)
         VALUES ($1,$2,'Workspace Rollout','ROLL','Migration and adoption of Infinity Workspace',$3)`,
        [projectId, companyId, adminId],
      );
      if (project.rowCount > 0) {
        await tx.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,'owner')`, [
          projectId,
          adminId,
        ]);
      }
    }

    return { companyId, adminId, invitationToken, created };
  });

  logger.info({ companyId: result.companyId, domain: DOMAIN }, 'seed complete');

  const lines = [
    '',
    '================ Infinity Workspace seeded ================',
    `Company:  ${COMPANY_NAME}`,
    `Domain:   ${DOMAIN}`,
    `Admin:    ${ADMIN_EMAIL}`,
  ];
  if (result.invitationToken) {
    lines.push(
      '',
      'No SEED_ADMIN_PASSWORD was provided, so an activation link was issued.',
      'Open it to set a password and enrol your authenticator app:',
      `  ${config.publicUrl}/activate?token=${result.invitationToken}`,
      '',
      'This link expires in 72 hours and works once.',
    );
  } else {
    lines.push('', 'Administrator password was taken from SEED_ADMIN_PASSWORD.');
  }
  if (result.created.length > 0) {
    lines.push('', 'Synthetic colleagues (development only) - activation links:', ...result.created.map((l) => `  ${l}`));
  }
  lines.push('==========================================================', '');
  process.stdout.write(lines.join('\n'));
}

seed()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'seed failed');
    process.exit(1);
  });

export { randomUUID };
