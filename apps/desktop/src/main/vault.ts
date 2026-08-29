import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StoredSession } from '../shared/contract';

/**
 * Where the session tokens live.
 *
 * The desktop client authenticates with bearer tokens rather than the browser's cookie
 * and CSRF pair, which means this process is now responsible for keeping a credential at
 * rest. It goes through the OS keystore - Keychain on macOS, DPAPI on Windows - so the
 * bytes on disk are useless to anything running as another user, and useless on another
 * machine entirely.
 *
 * The file is written only after encryption succeeds. If the OS keystore is unavailable
 * the token is not persisted at all and the person signs in again next launch, which is a
 * far better failure than a plaintext token sitting in the profile directory.
 */
const vaultPath = () => join(app.getPath('userData'), 'session.bin');

export function readSession(): StoredSession | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const encrypted = readFileSync(vaultPath());
    const plain = safeStorage.decryptString(encrypted);
    const parsed = JSON.parse(plain) as StoredSession;
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return parsed;
  } catch {
    // A missing, corrupt or undecryptable vault is simply "not signed in". It is never
    // an error worth surfacing: the remedy is identical either way.
    return null;
  }
}

export function writeSession(session: StoredSession): void {
  if (!safeStorage.isEncryptionAvailable()) {
    // Deliberately not falling back to plaintext.
    return;
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(session));
  const path = vaultPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encrypted, { mode: 0o600 });
}

export function clearSession(): void {
  try {
    rmSync(vaultPath(), { force: true });
  } catch {
    // Already gone is the desired end state.
  }
}
