/**
 * Local desktop notifications (banner).
 *
 * Used by runner.js to surface account switches, sleep, and wake events as an
 * OS-native banner — independent of Slack/remote access, so the user is alerted
 * even when running claude-nonstop without the Slack subsystem.
 *
 * macOS  -> osascript "display notification"
 * Linux  -> notify-send
 * other  -> no-op (returns null command)
 */

import { execFile } from 'child_process';
import { platform } from 'os';

/** Title prefix so every banner is recognizable as coming from this tool. */
const APP_LABEL = 'claude-nonstop';

/**
 * Build the OS-specific command for a desktop notification.
 *
 * Returns `{ cmd, args }` for execFile, or `null` on unsupported platforms.
 * Title/message are passed as process arguments (never concatenated into a
 * shell string or AppleScript source). On macOS the AppleScript reads them
 * from `argv` via `on run argv`, so arbitrary account names / reasons cannot
 * break out of the script or inject AppleScript — same guarantee execFile
 * gives us against shell injection.
 *
 * @param {string} title
 * @param {string} message
 * @param {string} [plat] - os.platform() value (injectable for tests)
 * @returns {{ cmd: string, args: string[] } | null}
 */
export function buildNotifyCommand(title, message, plat = platform()) {
  const safeTitle = String(title ?? APP_LABEL);
  const safeMessage = String(message ?? '');

  if (plat === 'darwin') {
    return {
      cmd: 'osascript',
      args: [
        '-e', 'on run argv',
        '-e', 'display notification (item 1 of argv) with title (item 2 of argv)',
        '-e', 'end run',
        safeMessage, safeTitle,
      ],
    };
  }

  if (plat === 'linux') {
    return { cmd: 'notify-send', args: [safeTitle, safeMessage] };
  }

  return null;
}

/**
 * Fire a desktop banner. Fire-and-forget: never throws, never blocks the
 * runner, and silently no-ops if the platform is unsupported or the helper
 * binary is missing.
 *
 * @param {string} title
 * @param {string} message
 * @param {{ execImpl?: Function, plat?: string }} [opts] - injectable for tests
 * @returns {boolean} whether a notification command was dispatched
 */
export function notifyDesktop(title, message, opts = {}) {
  // execImpl defaults to execFile (no shell, argument array) — never shell exec().
  const { execImpl = execFile, plat } = opts;
  try {
    const command = buildNotifyCommand(title, message, plat ?? platform());
    if (!command) return false;
    const child = execImpl(command.cmd, command.args, { timeout: 10_000 }, () => {});
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    /* notifications are best-effort; a failure must never disrupt switching */
    return false;
  }
}

export { APP_LABEL };
