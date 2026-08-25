/**
 * Object storage adapter (blueprint 11). Binary objects never live in the database.
 *
 * Two drivers ship: `local` (a private directory, for development and single-node
 * installs) and `s3` (any S3-compatible service, using SigV4 presigned URLs so clients
 * upload and download directly without proxying bytes through the API).
 *
 * Objects are never public: every read is a short-lived signed URL.
 */
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { config } from '../core/config.js';

export type PutResult = { objectKey: string; size: number; checksum: string };

export interface StorageDriver {
  readonly name: string;
  put(key: string, body: Readable | Buffer): Promise<PutResult>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Short-lived URL for a direct client download. */
  signedDownloadUrl(key: string, expiresInSeconds?: number, filename?: string): Promise<string>;
  /** Short-lived URL for a direct client upload, scoped to exact key and type. */
  signedUploadUrl(key: string, contentType: string, expiresInSeconds?: number): Promise<string>;
}

/** Object keys are derived server-side; user input never reaches the path. */
export function buildObjectKey(companyId: string, scope: string, id: string, version = 1): string {
  return `${companyId}/${scope}/${id}/v${version}`;
}

// ------------------------------------------------------------------ local driver

class LocalStorage implements StorageDriver {
  readonly name = 'local';
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const target = resolve(join(this.root, key));
    // Defence in depth against traversal even though keys are server-generated.
    if (!target.startsWith(this.root)) throw new Error('Invalid object key');
    return target;
  }

  async put(key: string, body: Readable | Buffer): Promise<PutResult> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const hash = createHash('sha256');
    let size = 0;
    if (Buffer.isBuffer(body)) {
      hash.update(body);
      size = body.length;
      await pipeline(async function* () { yield body; }, createWriteStream(target));
    } else {
      const out = createWriteStream(target);
      await pipeline(
        body,
        async function* (source) {
          for await (const chunk of source) {
            const buf = chunk as Buffer;
            hash.update(buf);
            size += buf.length;
            yield buf;
          }
        },
        out,
      );
    }
    return { objectKey: key, size, checksum: hash.digest('hex') };
  }

  async get(key: string): Promise<Readable> {
    return createReadStream(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  /** Local downloads go through the API's own signed streaming endpoint. */
  async signedDownloadUrl(key: string, expiresInSeconds = config.storage.signedUrlTtlSeconds, filename?: string): Promise<string> {
    return localSignedUrl('download', key, expiresInSeconds, filename);
  }

  async signedUploadUrl(key: string, _contentType: string, expiresInSeconds = config.storage.signedUrlTtlSeconds): Promise<string> {
    return localSignedUrl('upload', key, expiresInSeconds);
  }
}

/** HMAC-signed, expiring URL served by the API's /api/v1/objects endpoints. */
export function localSignedUrl(
  action: 'download' | 'upload',
  key: string,
  expiresInSeconds: number,
  filename?: string,
): string {
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const signature = signLocalObject(action, key, expires);
  const params = new URLSearchParams({ key, expires: String(expires), signature });
  if (filename) params.set('filename', filename);
  return `${config.apiUrl}/api/v1/objects/${action}?${params.toString()}`;
}

export function signLocalObject(action: string, key: string, expires: number): string {
  return createHmac('sha256', config.security.dataKey)
    .update(`${action}:${key}:${expires}`)
    .digest('hex');
}

export function verifyLocalObjectSignature(
  action: string,
  key: string,
  expires: number,
  signature: string,
): boolean {
  if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;
  const expected = signLocalObject(action, key, expires);
  return expected.length === signature.length &&
    createHash('sha256').update(expected).digest('hex') ===
      createHash('sha256').update(signature).digest('hex');
}

// ------------------------------------------------------------------ s3 driver

/** Minimal AWS SigV4 presigner - no SDK dependency, works with MinIO/R2/S3. */
class S3Storage implements StorageDriver {
  readonly name = 's3';

  private endpointHost(): string {
    if (config.storage.endpoint) return new URL(config.storage.endpoint).host;
    return `${config.storage.bucket}.s3.${config.storage.region}.amazonaws.com`;
  }

  private baseUrl(key: string): string {
    if (config.storage.endpoint) {
      return `${config.storage.endpoint.replace(/\/$/, '')}/${config.storage.bucket}/${key}`;
    }
    return `https://${this.endpointHost()}/${key}`;
  }

  private presign(method: 'GET' | 'PUT', key: string, expiresInSeconds: number, extraQuery: Record<string, string> = {}): string {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const region = config.storage.region;
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const host = this.endpointHost();
    const url = new URL(this.baseUrl(key));

    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${config.storage.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresInSeconds),
      'X-Amz-SignedHeaders': 'host',
      ...extraQuery,
    };
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
      .join('&');

    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQuery,
      `host:${host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const kDate = createHmac('sha256', `AWS4${config.storage.secretAccessKey}`).update(dateStamp).digest();
    const kRegion = createHmac('sha256', kDate).update(region).digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  async put(key: string, body: Readable | Buffer): Promise<PutResult> {
    const buffer = Buffer.isBuffer(body) ? body : await streamToBuffer(body);
    const url = this.presign('PUT', key, 300);
    const res = await fetch(url, { method: 'PUT', body: buffer });
    if (!res.ok) throw new Error(`Object storage rejected upload: ${res.status}`);
    return {
      objectKey: key,
      size: buffer.length,
      checksum: createHash('sha256').update(buffer).digest('hex'),
    };
  }

  async get(key: string): Promise<Readable> {
    const res = await fetch(this.presign('GET', key, 300));
    if (!res.ok || !res.body) throw new Error(`Object storage read failed: ${res.status}`);
    const { Readable: NodeReadable } = await import('node:stream');
    return NodeReadable.fromWeb(res.body as Parameters<typeof NodeReadable.fromWeb>[0]);
  }

  async delete(key: string): Promise<void> {
    await fetch(this.presign('GET', key, 60).replace('X-Amz-Algorithm', 'X-Amz-Algorithm'), {
      method: 'DELETE',
    });
  }

  async exists(key: string): Promise<boolean> {
    const res = await fetch(this.presign('GET', key, 60), { method: 'HEAD' });
    return res.ok;
  }

  async signedDownloadUrl(key: string, expiresInSeconds = config.storage.signedUrlTtlSeconds, filename?: string): Promise<string> {
    const extra = filename
      ? { 'response-content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"` }
      : {};
    return this.presign('GET', key, expiresInSeconds, extra);
  }

  async signedUploadUrl(key: string, _contentType: string, expiresInSeconds = config.storage.signedUrlTtlSeconds): Promise<string> {
    return this.presign('PUT', key, expiresInSeconds);
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export const storage: StorageDriver =
  config.storage.driver === 's3' ? new S3Storage() : new LocalStorage(config.storage.localRoot);
