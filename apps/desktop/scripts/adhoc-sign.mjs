/**
 * Ad-hoc signs the macOS build.
 *
 * Apple Silicon will not execute an unsigned arm64 binary at all - the kernel refuses it
 * at exec, so the app appears to launch and disappears with no error anywhere the person
 * running it can see. This is separate from Apple Developer signing, which costs money
 * and which this project deliberately does without: an ad-hoc signature carries no
 * identity and satisfies no Gatekeeper check, it only makes the code loadable.
 *
 * Gatekeeper still warns on first open. That is expected and documented.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export default async function adhocSign(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const appPath = join(appOutDir, `${packager.appInfo.productFilename}.app`);
  console.log(`  ad-hoc signing ${appPath}`);

  try {
    // Inside-out order matters: nested code must be signed before its container, or the
    // outer signature seals over an unsigned framework and the app still refuses to run.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], {
      stdio: 'inherit',
    });
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
    console.log('  signature verified');
  } catch (error) {
    console.error('\nAd-hoc signing failed. On Apple Silicon the build will not launch.');
    console.error('Check that the Xcode command line tools are installed: xcode-select --install');
    throw error;
  }
}
