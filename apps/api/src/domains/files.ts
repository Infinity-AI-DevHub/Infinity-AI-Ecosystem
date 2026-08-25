/**
 * Files domain (blueprint 11).
 *
 * Upload pipeline: authorize -> quota check -> open session -> client uploads to private
 * object storage -> finalize with checksum -> worker verifies, MIME-sniffs, scans and
 * extracts searchable text. The file stays in `processing` (and `quarantined` on a bad
 * verdict) until checks pass; users never receive a public permanent object URL.
 */
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { many, one, pool, transaction } from '../core/db.js';
import { conflict, forbidden, notFound, payloadTooLarge, unprocessable } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';
import { buildObjectKey, storage } from '../adapters/storage.js';
import { scanBuffer, sniffMimeType } from '../adapters/scanner.js';
import { config } from '../core/config.js';
import { safeFilename } from '../core/validation.js';
import * as searchIndex from './search.js';

export type FileRow = {
  id: string;
  company_id: string;
  folder_id: string | null;
  name: string;
  owner_id: string | null;
  classification: string;
  state: string;
  current_version: number;
  size_bytes: number;
  mime_type: string;
  recycled_at: Date | null;
  retention_until: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
};

/** Ownership, an explicit grant, or folder membership authorizes a file operation. */
async function requireFileAccess(actor: Actor, fileId: string, capability: string) {
  const file = await one<FileRow>('SELECT * FROM files WHERE id = $1 AND company_id = $2', [
    fileId,
    actor.companyId,
  ]);
  if (!file) throw notFound('File not found');
  await authorize({
    actor,
    capability,
    resourceType: 'file',
    resourceId: fileId,
    membership: file.owner_id === actor.userId,
  });
  return file;
}

export async function listFolders(actor: Actor) {
  return many('SELECT id, parent_id, name, path, owner_id FROM folders WHERE company_id = $1 ORDER BY path', [
    actor.companyId,
  ]);
}

export async function createFolder(actor: Actor, name: string, parentId: string | null) {
  await authorize({ actor, capability: 'file.create', resourceless: true });
  const clean = safeFilename(name).replace(/\//g, '');
  if (!clean) throw unprocessable('Folder name is required', [{ field: 'name', message: 'Enter a name' }]);
  const parent = parentId
    ? await one<{ path: string }>('SELECT path FROM folders WHERE id = $1 AND company_id = $2', [
        parentId,
        actor.companyId,
      ])
    : null;
  if (parentId && !parent) throw notFound('Parent folder not found');
  const path = `${parent?.path ?? ''}/${clean}`;
  const existing = await one('SELECT 1 FROM folders WHERE company_id = $1 AND path = $2', [
    actor.companyId,
    path,
  ]);
  if (existing) throw conflict('A folder with that name already exists here');
  const res = await pool.query(
    `INSERT INTO folders (company_id, parent_id, name, owner_id, path) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, parent_id, name, path`,
    [actor.companyId, parentId, clean, actor.userId, path],
  );
  return res.rows[0];
}

export type UploadSession = {
  uploadId: string;
  fileId: string;
  objectKey: string;
  uploadUrl: string;
  expiresAt: Date;
};

/** Storage quota is enforced before an upload is allowed to start. */
async function assertQuota(companyId: string, additionalBytes: number): Promise<void> {
  const row = await one<{ used: number; quota: number }>(
    `SELECT COALESCE(sum(size_bytes),0)::bigint AS used,
            COALESCE((SELECT (settings->>'storageQuotaBytes')::bigint FROM companies WHERE id = $1),
                     1099511627776)::bigint AS quota
       FROM files WHERE company_id = $1 AND state <> 'expired'`,
    [companyId],
  );
  if (row && Number(row.used) + additionalBytes > Number(row.quota)) {
    throw payloadTooLarge('Company storage quota has been reached');
  }
}

export async function beginUpload(
  actor: Actor,
  input: { filename: string; mimeType: string; sizeBytes: number; folderId?: string | null; fileId?: string },
): Promise<UploadSession> {
  await authorize({ actor, capability: input.fileId ? 'file.update' : 'file.create', resourceless: true });
  if (input.sizeBytes <= 0 || input.sizeBytes > config.limits.uploadMaxBytes) {
    throw payloadTooLarge(`Files must be between 1 byte and ${config.limits.uploadMaxBytes} bytes`);
  }
  await assertQuota(actor.companyId, input.sizeBytes);
  const filename = safeFilename(input.filename);

  return transaction(async (tx) => {
    let fileId = input.fileId ?? null;
    let nextVersion = 1;

    if (fileId) {
      const existing = await requireFileAccess(actor, fileId, 'file.update');
      if (existing.state === 'legal_hold') throw forbidden('This file is under legal hold');
      nextVersion = existing.current_version + 1;
    } else {
      const res = await tx.query<FileRow>(
        `INSERT INTO files (company_id, folder_id, name, owner_id, mime_type, state)
         VALUES ($1,$2,$3,$4,$5,'processing') RETURNING *`,
        [actor.companyId, input.folderId ?? null, filename, actor.userId, input.mimeType],
      );
      fileId = res.rows[0]!.id;
    }

    const objectKey = buildObjectKey(actor.companyId, 'files', fileId, nextVersion);
    const expiresAt = new Date(Date.now() + 3600_000);
    const session = await tx.query<{ id: string }>(
      `INSERT INTO upload_sessions
         (company_id, user_id, file_id, folder_id, filename, mime_type, declared_size, object_key, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        actor.companyId,
        actor.userId,
        fileId,
        input.folderId ?? null,
        filename,
        input.mimeType,
        input.sizeBytes,
        objectKey,
        expiresAt,
      ],
    );
    const uploadUrl = await storage.signedUploadUrl(objectKey, input.mimeType);
    return { uploadId: session.rows[0]!.id, fileId, objectKey, uploadUrl, expiresAt };
  });
}

/**
 * Server-side receipt of the bytes. Used by the direct-upload endpoint; when the client
 * uploads straight to object storage this becomes a verification step instead.
 */
export async function receiveUpload(
  actor: Actor,
  uploadId: string,
  body: Buffer,
): Promise<FileRow> {
  const session = await one<{
    id: string;
    file_id: string;
    filename: string;
    mime_type: string;
    declared_size: number;
    object_key: string;
    state: string;
    user_id: string;
  }>(
    `SELECT * FROM upload_sessions WHERE id = $1 AND company_id = $2 AND expires_at > now()`,
    [uploadId, actor.companyId],
  );
  if (!session) throw notFound('Upload session not found or expired');
  if (session.user_id !== actor.userId) throw forbidden('This upload belongs to someone else');
  if (session.state !== 'open') throw conflict('This upload was already finalized');
  if (body.length > config.limits.uploadMaxBytes) throw payloadTooLarge();

  // The declared content type is never trusted.
  const sniffed = sniffMimeType(body, session.mime_type);
  const verdict = await scanBuffer(body, session.filename);
  const put = await storage.put(session.object_key, body);

  const file = await transaction(async (tx) => {
    await tx.query(`UPDATE upload_sessions SET state = 'complete' WHERE id = $1`, [uploadId]);
    const versionRes = await tx.query<{ version: number }>(
      `SELECT COALESCE(max(version), 0) + 1 AS version FROM file_versions WHERE file_id = $1`,
      [session.file_id],
    );
    const version = versionRes.rows[0]?.version ?? 1;
    await tx.query(
      `INSERT INTO file_versions
         (company_id, file_id, version, object_key, size_bytes, checksum, mime_type, scan_state, scan_detail, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        actor.companyId,
        session.file_id,
        version,
        put.objectKey,
        put.size,
        put.checksum,
        sniffed,
        verdict.state,
        verdict.detail ?? null,
        actor.userId,
      ],
    );
    const state = verdict.state === 'infected' ? 'quarantined' : 'active';
    const res = await tx.query<FileRow>(
      `UPDATE files SET current_version = $2, size_bytes = $3, mime_type = $4, state = $5,
              version = version + 1, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [session.file_id, version, put.size, sniffed, state],
    );
    await auditFromActor(
      actor,
      version === 1 ? 'file.create' : 'file.version',
      {
        resourceType: 'file',
        resourceId: session.file_id,
        metadata: { version, sizeBytes: put.size, scanState: verdict.state, mimeType: sniffed },
      },
      tx,
    );
    await emit(
      {
        companyId: actor.companyId,
        type: version === 1 ? 'file.created' : 'file.versioned',
        actorId: actor.userId,
        payload: { fileId: session.file_id, version, scanState: verdict.state },
      },
      tx,
    );
    return res.rows[0]!;
  });

  if (verdict.state === 'infected') {
    throw unprocessable('This file was quarantined by the malware scanner', [
      { field: 'file', message: verdict.detail ?? 'Blocked by content scanning' },
    ]);
  }
  return file;
}

export async function listFiles(actor: Actor, opts: { folderId?: string | null; limit: number }) {
  return many<FileRow & { owner_name: string | null }>(
    `SELECT f.*, u.display_name AS owner_name
       FROM files f LEFT JOIN users u ON u.id = f.owner_id
      WHERE f.company_id = $1
        AND f.state IN ('active','processing','quarantined','legal_hold')
        AND ($2::uuid IS NULL OR f.folder_id = $2)
        AND (
          f.owner_id = $3
          OR EXISTS (
            SELECT 1 FROM resource_grants g
             WHERE g.resource_type = 'file' AND g.resource_id = f.id AND g.effect = 'allow'
               AND ((g.subject_type = 'user' AND g.subject_id = $3)
                 OR (g.subject_type = 'group' AND g.subject_id = ANY($4::uuid[])))
          )
          OR $5
        )
      ORDER BY f.updated_at DESC
      LIMIT $6`,
    [
      actor.companyId,
      opts.folderId ?? null,
      actor.userId,
      actor.groupIds,
      actor.accessLevel === 'admin' || actor.accessLevel === 'super_admin',
      opts.limit,
    ],
  ).then((rows) => rows.map(publicFile));
}

/** Downloads are always short-lived signed URLs; quarantined content is never served. */
export async function downloadUrl(actor: Actor, fileId: string, versionNumber?: number) {
  const file = await requireFileAccess(actor, fileId, 'file.read');
  if (file.state === 'quarantined') throw forbidden('This file is quarantined and cannot be downloaded');
  if (file.state === 'processing') throw conflict('This file is still being processed');

  const version = await one<{ object_key: string; scan_state: string; version: number }>(
    `SELECT object_key, scan_state, version FROM file_versions
      WHERE file_id = $1 AND ($2::int IS NULL OR version = $2)
      ORDER BY version DESC LIMIT 1`,
    [fileId, versionNumber ?? null],
  );
  if (!version) throw notFound('File content not found');
  if (version.scan_state === 'infected') throw forbidden('This version is quarantined');

  await auditFromActor(actor, 'file.download', {
    resourceType: 'file',
    resourceId: fileId,
    metadata: { version: version.version },
  });
  return {
    url: await storage.signedDownloadUrl(version.object_key, config.storage.signedUrlTtlSeconds, file.name),
    expiresInSeconds: config.storage.signedUrlTtlSeconds,
    filename: file.name,
  };
}

export async function readStream(objectKey: string): Promise<Readable> {
  return storage.get(objectKey);
}

export async function listVersions(actor: Actor, fileId: string) {
  await requireFileAccess(actor, fileId, 'file.read');
  return many(
    `SELECT v.version, v.size_bytes, v.checksum, v.mime_type, v.scan_state, v.created_at,
            u.display_name AS uploaded_by_name
       FROM file_versions v LEFT JOIN users u ON u.id = v.uploaded_by
      WHERE v.file_id = $1 ORDER BY v.version DESC`,
    [fileId],
  );
}

/** Internal sharing grant. External/guest sharing stays closed until governance approves it. */
export async function share(
  actor: Actor,
  fileId: string,
  input: { subjectType: 'user' | 'group'; subjectId: string; capabilities: string[]; expiresAt?: string | null },
) {
  const file = await requireFileAccess(actor, fileId, 'file.share_internal');
  if (file.classification === 'restricted' && actor.accessLevel !== 'super_admin') {
    throw forbidden('Restricted files can only be shared by a super administrator');
  }
  const allowed = input.capabilities.filter((c) => ['file.read', 'file.update', 'file.delete'].includes(c));
  if (allowed.length === 0) {
    throw unprocessable('Choose at least one permission', [
      { field: 'capabilities', message: 'file.read, file.update or file.delete' },
    ]);
  }
  const res = await pool.query(
    `INSERT INTO resource_grants
       (company_id, subject_type, subject_id, resource_type, resource_id, capabilities, granted_by, expires_at)
     VALUES ($1,$2,$3,'file',$4,$5,$6,$7) RETURNING id`,
    [
      actor.companyId,
      input.subjectType,
      input.subjectId,
      fileId,
      allowed,
      actor.userId,
      input.expiresAt ? new Date(input.expiresAt) : null,
    ],
  );
  await auditFromActor(actor, 'file.share', {
    resourceType: 'file',
    resourceId: fileId,
    metadata: { subjectType: input.subjectType, subjectId: input.subjectId, capabilities: allowed },
  });
  await indexFile(fileId);
  return { grantId: (res.rows[0] as { id: string }).id };
}

/** Deletion moves to the recycle bin; legal hold blocks it outright. */
export async function recycle(actor: Actor, fileId: string): Promise<void> {
  const file = await requireFileAccess(actor, fileId, 'file.delete');
  if (file.state === 'legal_hold') throw forbidden('This file is under legal hold and cannot be deleted');
  await transaction(async (tx) => {
    await tx.query(
      `UPDATE files SET state = 'recycled', recycled_at = now(),
              retention_until = now() + ($2 || ' days')::interval,
              version = version + 1, updated_at = now()
        WHERE id = $1`,
      [fileId, config.retention.recycleBinDays],
    );
    await auditFromActor(actor, 'file.recycle', { resourceType: 'file', resourceId: fileId }, tx);
    await emit(
      { companyId: actor.companyId, type: 'file.recycled', actorId: actor.userId, payload: { fileId } },
      tx,
    );
  });
  await searchIndex.remove('file', fileId);
}

export async function restore(actor: Actor, fileId: string): Promise<FileRow> {
  await authorize({ actor, capability: 'file.restore', resourceType: 'file', resourceId: fileId });
  const res = await pool.query<FileRow>(
    `UPDATE files SET state = 'active', recycled_at = NULL, retention_until = NULL,
            version = version + 1, updated_at = now()
      WHERE id = $1 AND company_id = $2 AND state = 'recycled' RETURNING *`,
    [fileId, actor.companyId],
  );
  const file = res.rows[0];
  if (!file) throw notFound('No recycled file with that identifier');
  await auditFromActor(actor, 'file.restore', { resourceType: 'file', resourceId: fileId });
  await indexFile(fileId);
  return file;
}

export async function setLegalHold(actor: Actor, fileId: string, held: boolean): Promise<void> {
  await authorize({ actor, capability: 'legal_hold.manage', resourceType: 'file', resourceId: fileId });
  await pool.query(
    `UPDATE files SET state = $3, version = version + 1, updated_at = now()
      WHERE id = $1 AND company_id = $2`,
    [fileId, actor.companyId, held ? 'legal_hold' : 'active'],
  );
  await auditFromActor(actor, held ? 'file.legal_hold_set' : 'file.legal_hold_released', {
    resourceType: 'file',
    resourceId: fileId,
  });
}

export async function indexFile(fileId: string): Promise<void> {
  const file = await one<FileRow>('SELECT * FROM files WHERE id = $1', [fileId]);
  if (!file || file.state !== 'active') return;
  const grants = await many<{ subject_type: string; subject_id: string }>(
    `SELECT subject_type, subject_id FROM resource_grants
      WHERE resource_type = 'file' AND resource_id = $1 AND effect = 'allow'`,
    [fileId],
  );
  await searchIndex.index({
    companyId: file.company_id,
    docType: 'file',
    resourceId: file.id,
    title: file.name,
    body: file.name,
    classification: file.classification,
    aclUserIds: [
      file.owner_id,
      ...grants.filter((g) => g.subject_type === 'user').map((g) => g.subject_id),
    ].filter((v): v is string => !!v),
    aclGroupIds: grants.filter((g) => g.subject_type === 'group').map((g) => g.subject_id),
    link: `/files/${file.id}`,
  });
}

export function publicFile(row: FileRow & { owner_name?: string | null }) {
  return {
    id: row.id,
    folderId: row.folder_id,
    name: row.name,
    ownerId: row.owner_id,
    ownerName: row.owner_name ?? null,
    classification: row.classification,
    state: row.state,
    currentVersion: row.current_version,
    sizeBytes: Number(row.size_bytes),
    mimeType: row.mime_type,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export { randomUUID };
