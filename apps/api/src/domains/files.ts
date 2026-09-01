/**
 * Files domain (blueprint 11).
 *
 * Upload pipeline: authorize -> quota check -> open session -> client uploads to private
 * object storage -> finalize with checksum -> worker verifies, MIME-sniffs, scans and
 * extracts searchable text. The file stays in `processing` (and `quarantined` on a bad
 * verdict) until checks pass; users never receive a public permanent object URL.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { many, newId, one, pool, reload, transaction } from '../core/db.js';
import { conflict, forbidden, notFound, payloadTooLarge, unprocessable } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';
import { buildObjectKey, storage } from '../adapters/storage.js';
import { scanBuffer, sniffMimeType } from '../adapters/scanner.js';
import { config } from '../core/config.js';
import { safeFilename } from '../core/validation.js';
import { logger } from '../core/logger.js';
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
  const folderId = newId();
  await pool.query(
    `INSERT INTO folders (id, company_id, parent_id, name, owner_id, path)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [folderId, actor.companyId, parentId, clean, actor.userId, path],
  );
  return { id: folderId, parent_id: parentId, name: clean, path };
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
    `SELECT COALESCE(sum(size_bytes),0) AS used,
            COALESCE((SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(settings, '$.storageQuotaBytes')) AS UNSIGNED)
                        FROM companies WHERE id = $1),
                     1099511627776) AS quota
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
      fileId = newId();
      await tx.query(
        `INSERT INTO files (id, company_id, folder_id, name, owner_id, mime_type, state)
         VALUES ($1,$2,$3,$4,$5,$6,'processing')`,
        [fileId, actor.companyId, input.folderId ?? null, filename, actor.userId, input.mimeType],
      );
    }

    const objectKey = buildObjectKey(actor.companyId, 'files', fileId, nextVersion);
    const expiresAt = new Date(Date.now() + 3600_000);
    const uploadId = newId();
    await tx.query(
      `INSERT INTO upload_sessions
         (id, company_id, user_id, file_id, folder_id, filename, mime_type, declared_size, object_key, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        uploadId,
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
    return { uploadId, fileId, objectKey, uploadUrl, expiresAt };
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
  const session = await claimUpload(actor, uploadId);
  try {
    return await finalizeUpload(actor, uploadId, body, false, session);
  } catch (error) {
    await releaseUpload(uploadId);
    throw error;
  }
}

type UploadSessionRow = {
  id: string;
  file_id: string;
  filename: string;
  mime_type: string;
  declared_size: number;
  object_key: string;
  state: string;
  user_id: string;
};

async function uploadSession(actor: Actor, uploadId: string): Promise<UploadSessionRow> {
  const session = await one<UploadSessionRow>(
    `SELECT * FROM upload_sessions WHERE id = $1 AND company_id = $2 AND expires_at > NOW(3)`,
    [uploadId, actor.companyId],
  );
  if (!session) throw notFound('Upload session not found or expired');
  if (session.user_id !== actor.userId) throw forbidden('This upload belongs to someone else');
  if (session.state !== 'open') throw conflict('This upload was already finalized');
  return session;
}

/** Finalizes bytes previously sent to the short-lived signed object URL. */
export async function completeUpload(actor: Actor, uploadId: string): Promise<FileRow> {
  const session = await claimUpload(actor, uploadId);
  try {
    if (!(await storage.exists(session.object_key))) throw conflict('The file has not finished uploading yet');
    const stream = await storage.get(session.object_key);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > config.limits.uploadMaxBytes) throw payloadTooLarge();
      chunks.push(buffer);
    }
    return await finalizeUpload(actor, uploadId, Buffer.concat(chunks), true, session);
  } catch (error) {
    await releaseUpload(uploadId);
    throw error;
  }
}

async function claimUpload(actor: Actor, uploadId: string): Promise<UploadSessionRow> {
  const session = await uploadSession(actor, uploadId);
  const claimed = await pool.query(
    `UPDATE upload_sessions SET state = 'finalizing' WHERE id = $1 AND state = 'open'`,
    [uploadId],
  );
  if ((claimed.rowCount ?? 0) === 0) throw conflict('This upload is already being finalized');
  return session;
}

async function releaseUpload(uploadId: string): Promise<void> {
  await pool.query(`UPDATE upload_sessions SET state = 'open' WHERE id = $1 AND state = 'finalizing'`, [uploadId]);
}

/** Recovers uploads whose object arrived but whose completion request was interrupted. */
export async function recoverPendingUploads(limit = 10): Promise<number> {
  const pending = await many<{
    id: string;
    user_id: string;
    company_id: string;
    email: string;
    display_name: string;
    access_level: Actor['accessLevel'];
    status: string;
    department_id: string | null;
    manager_id: string | null;
  }>(
    `SELECT s.id, s.user_id, s.company_id, u.email_display AS email, u.display_name,
            u.access_level, u.status, u.department_id, u.manager_id
       FROM upload_sessions s
       JOIN files f ON f.id = s.file_id AND f.state = 'processing'
       JOIN users u ON u.id = s.user_id AND u.company_id = s.company_id
      WHERE s.state = 'open' AND s.expires_at > NOW(3)
      ORDER BY s.created_at
      LIMIT $1`,
    [limit],
  );
  let recovered = 0;
  for (const item of pending) {
    try {
      const session = await uploadSession({
        userId: item.user_id,
        companyId: item.company_id,
        email: item.email,
        displayName: item.display_name,
        accessLevel: item.access_level,
        status: item.status,
        departmentId: item.department_id,
        managerId: item.manager_id,
        capabilities: new Set(),
        groupIds: [],
        sessionId: null,
        tokenId: null,
        tokenScopes: null,
      }, item.id);
      if (!(await storage.exists(session.object_key))) continue;
      await completeUpload({
        userId: item.user_id, companyId: item.company_id, email: item.email,
        displayName: item.display_name, accessLevel: item.access_level, status: item.status,
        departmentId: item.department_id, managerId: item.manager_id, capabilities: new Set(),
        groupIds: [], sessionId: null, tokenId: null, tokenScopes: null,
      }, item.id);
      recovered += 1;
    } catch (error) {
      logger.warn({ err: error, uploadId: item.id }, 'pending upload recovery failed');
    }
  }
  return recovered;
}

async function finalizeUpload(
  actor: Actor,
  uploadId: string,
  body: Buffer,
  alreadyStored: boolean,
  knownSession?: UploadSessionRow,
): Promise<FileRow> {
  const session = knownSession ?? await uploadSession(actor, uploadId);
  if (body.length > config.limits.uploadMaxBytes) throw payloadTooLarge();
  if (body.length !== session.declared_size) {
    throw unprocessable('The uploaded file size does not match the reserved upload', [
      { field: 'file', message: 'Choose the file again and retry the upload' },
    ]);
  }

  // The declared content type is never trusted.
  const sniffed = sniffMimeType(body, session.mime_type);
  const verdict = await scanBuffer(body, session.filename);
  const put = alreadyStored
    ? {
        objectKey: session.object_key,
        size: body.length,
        checksum: createHash('sha256').update(body).digest('hex'),
      }
    : await storage.put(session.object_key, body);

  const file = await transaction(async (tx) => {
    await tx.query(`UPDATE upload_sessions SET state = 'complete' WHERE id = $1`, [uploadId]);
    // Lock the file row so two concurrent uploads cannot claim the same version.
    await tx.query('SELECT 1 FROM files WHERE id = $1 FOR UPDATE', [session.file_id]);
    const versionRes = await tx.query<{ version: number }>(
      `SELECT COALESCE(max(version), 0) + 1 AS version FROM file_versions WHERE file_id = $1`,
      [session.file_id],
    );
    const version = versionRes.rows[0]?.version ?? 1;
    await tx.query(
      `INSERT INTO file_versions
         (id, company_id, file_id, version, object_key, size_bytes, checksum, mime_type,
          scan_state, scan_detail, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        newId(),
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
    await tx.query(
      `UPDATE files SET current_version = $2, size_bytes = $3, mime_type = $4, state = $5,
              version = version + 1, updated_at = NOW(3)
        WHERE id = $1`,
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
    return (await reload<FileRow>(tx, 'files', session.file_id))!;
  });

  if (verdict.state === 'infected') {
    throw unprocessable('This file was quarantined by the malware scanner', [
      { field: 'file', message: verdict.detail ?? 'Blocked by content scanning' },
    ]);
  }
  return file;
}

export async function listFiles(
  actor: Actor,
  opts: { folderId?: string | null; limit: number; recycled?: boolean },
) {
  return many<FileRow & { owner_name: string | null }>(
    `SELECT f.*, u.display_name AS owner_name
       FROM files f LEFT JOIN users u ON u.id = f.owner_id
      WHERE f.company_id = $1
        -- The recycle bin is a separate view, not a filter over the active list.
        AND (CASE WHEN $7
                  THEN f.state = 'recycled'
                  ELSE f.state IN ('active','processing','quarantined','legal_hold')
             END)
        AND ($2 IS NULL OR f.folder_id = $2)
        AND (
          f.owner_id = $3
          OR EXISTS (
            SELECT 1 FROM resource_grants g
             WHERE g.resource_type = 'file' AND g.resource_id = f.id AND g.effect = 'allow'
               AND ((g.subject_type = 'user' AND g.subject_id = $3)
                 OR (g.subject_type = 'group' AND JSON_CONTAINS($4, JSON_QUOTE(g.subject_id))))
          )
          OR $5
        )
      ORDER BY f.updated_at DESC
      LIMIT $6`,
    [
      actor.companyId,
      opts.folderId ?? null,
      actor.userId,
      JSON.stringify(actor.groupIds),
      actor.accessLevel === 'admin' || actor.accessLevel === 'super_admin',
      opts.limit,
      opts.recycled ?? false,
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
      WHERE file_id = $1 AND ($2 IS NULL OR version = $2)
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
  const grantId = newId();
  await pool.query(
    `INSERT INTO resource_grants
       (id, company_id, subject_type, subject_id, resource_type, resource_id,
        capabilities, conditions, granted_by, expires_at)
     VALUES ($1,$2,$3,$4,'file',$5,$6,'{}',$7,$8)`,
    [
      grantId,
      actor.companyId,
      input.subjectType,
      input.subjectId,
      fileId,
      JSON.stringify(allowed),
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
  return { grantId };
}

/** Deletion moves to the recycle bin; legal hold blocks it outright. */
export async function recycle(actor: Actor, fileId: string): Promise<void> {
  const file = await requireFileAccess(actor, fileId, 'file.delete');
  if (file.state === 'legal_hold') throw forbidden('This file is under legal hold and cannot be deleted');
  await transaction(async (tx) => {
    await tx.query(
      `UPDATE files SET state = 'recycled', recycled_at = NOW(3),
              retention_until = DATE_ADD(NOW(3), INTERVAL $2 DAY),
              version = version + 1, updated_at = NOW(3)
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
  const res = await pool.query(
    `UPDATE files SET state = 'active', recycled_at = NULL, retention_until = NULL,
            version = version + 1, updated_at = NOW(3)
      WHERE id = $1 AND company_id = $2 AND state = 'recycled'`,
    [fileId, actor.companyId],
  );
  if (res.rowCount === 0) throw notFound('No recycled file with that identifier');
  const file = (await reload<FileRow>(pool, 'files', fileId))!;
  await auditFromActor(actor, 'file.restore', { resourceType: 'file', resourceId: fileId });
  await indexFile(fileId);
  return file;
}

export async function setLegalHold(actor: Actor, fileId: string, held: boolean): Promise<void> {
  await authorize({ actor, capability: 'legal_hold.manage', resourceType: 'file', resourceId: fileId });
  await pool.query(
    `UPDATE files SET state = $3, version = version + 1, updated_at = NOW(3)
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

/**
 * Signed download for a share link, where there is no actor to authorize.
 *
 * The authorization already happened: a valid, unexpired, unrevoked share link was
 * resolved and consumed before this is reached. What must not be skipped is the safety
 * check - a quarantined or unscanned file is exactly what should never leave the company
 * through an anonymous link, so those refusals are repeated here rather than assumed.
 */
export async function signedDownloadForShare(fileId: string) {
  const file = await one<{ id: string; name: string; state: string }>(
    'SELECT id, name, state FROM files WHERE id = $1',
    [fileId],
  );
  if (!file) throw notFound('File not found');
  if (file.state !== 'active') throw forbidden('This file is not available');

  const version = await one<{ object_key: string; scan_state: string }>(
    `SELECT object_key, scan_state FROM file_versions
      WHERE file_id = $1 ORDER BY version DESC LIMIT 1`,
    [fileId],
  );
  if (!version) throw notFound('File content not found');
  if (version.scan_state === 'infected') throw forbidden('This version is quarantined');
  // Unlike an internal download, an unscanned file is refused rather than allowed
  // through: nobody outside the company should be the one to discover it was malware.
  if (version.scan_state === 'pending') {
    throw conflict('This file is still being checked; try again shortly');
  }

  return {
    url: await storage.signedDownloadUrl(
      version.object_key,
      config.storage.signedUrlTtlSeconds,
      file.name,
    ),
    expiresInSeconds: config.storage.signedUrlTtlSeconds,
    filename: file.name,
  };
}
