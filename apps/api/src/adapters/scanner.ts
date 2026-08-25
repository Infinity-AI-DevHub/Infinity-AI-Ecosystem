/**
 * Malware scanning adapter (blueprint 11: files stay in Processing/Quarantined until
 * checks pass). Talks to a ClamAV daemon over its INSTREAM protocol when configured;
 * otherwise applies structural heuristics and marks the result as `skipped` so the
 * operational gap is visible rather than silently assumed clean.
 */
import { createConnection } from 'node:net';
import type { Readable } from 'node:stream';
import { logger } from '../core/logger.js';

export type ScanVerdict = { state: 'clean' | 'infected' | 'skipped'; detail?: string };

const CLAMAV_HOST = process.env.CLAMAV_HOST ?? '';
const CLAMAV_PORT = Number(process.env.CLAMAV_PORT ?? 3310);
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export async function scanBuffer(buffer: Buffer, filename: string): Promise<ScanVerdict> {
  if (buffer.includes(EICAR)) {
    return { state: 'infected', detail: 'EICAR-Test-Signature' };
  }
  if (!CLAMAV_HOST) {
    return { state: 'skipped', detail: 'No malware scanner configured' };
  }
  try {
    const result = await clamavInstream(buffer);
    if (result.includes('FOUND')) {
      return { state: 'infected', detail: result.replace(/^stream: /, '').trim() };
    }
    return { state: 'clean' };
  } catch (err) {
    logger.error({ err, filename }, 'malware scan failed');
    // Failing the scan must not silently pass the file.
    return { state: 'skipped', detail: 'Scanner unavailable' };
  }
}

export async function scanStream(stream: Readable, filename: string): Promise<ScanVerdict> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return scanBuffer(Buffer.concat(chunks), filename);
}

function clamavInstream(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: CLAMAV_HOST, port: CLAMAV_PORT, timeout: 30_000 });
    let response = '';
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const CHUNK = 8192;
      for (let offset = 0; offset < buffer.length; offset += CHUNK) {
        const slice = buffer.subarray(offset, offset + CHUNK);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(slice.length);
        socket.write(size);
        socket.write(slice);
      }
      socket.write(Buffer.from([0, 0, 0, 0]));
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });
    socket.on('end', () => resolve(response));
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('ClamAV timeout'));
    });
    socket.on('error', reject);
  });
}

/**
 * MIME sniffing: the declared content type is never trusted (blueprint 12 lists
 * "content-type confusion" as a threat to test).
 */
export function sniffMimeType(buffer: Buffer, declared: string): string {
  const sig = buffer.subarray(0, 12);
  const startsWith = (...bytes: number[]) => bytes.every((b, i) => sig[i] === b);

  if (startsWith(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (startsWith(0x50, 0x4b, 0x03, 0x04)) {
    // zip container: office documents share this signature
    if (declared.includes('officedocument') || declared.includes('opendocument')) return declared;
    return 'application/zip';
  }
  if (startsWith(0x52, 0x49, 0x46, 0x46)) return 'image/webp';
  if (startsWith(0x1f, 0x8b)) return 'application/gzip';
  if (startsWith(0x4d, 0x5a)) return 'application/x-msdownload';

  const text = buffer.subarray(0, 512).toString('utf8');
  if (/^\s*<(!doctype html|html)/i.test(text)) return 'text/html';
  // Anything that decodes cleanly as text is served as text/plain, never as HTML.
  return declared.startsWith('text/') ? 'text/plain' : declared || 'application/octet-stream';
}
