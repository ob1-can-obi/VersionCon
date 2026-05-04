import * as vscode from 'vscode';

/**
 * Key prefix for invite codes in VS Code SecretStorage.
 * Full key format: 'versioncon.invite.{sessionName}'
 */
const SECRET_PREFIX = 'versioncon.invite.';

/**
 * Wraps VS Code SecretStorage API for secure invite code persistence.
 *
 * Invite codes are stored using platform-native encryption
 * (macOS Keychain, Windows Credential Manager, Linux Keyring)
 * via the VS Code SecretStorage API (T-01-12 mitigation).
 *
 * This is separate from SessionHistory which uses globalState —
 * invite codes must never be stored in plaintext (T-01-11).
 */
export class SecretStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Store an invite code securely for a given session.
   *
   * @param sessionName - The session identifier
   * @param code - The invite code to store
   */
  async storeInviteCode(sessionName: string, code: string): Promise<void> {
    await this.context.secrets.store(SECRET_PREFIX + sessionName, code);
  }

  /**
   * Retrieve a stored invite code for a session.
   *
   * @param sessionName - The session identifier
   * @returns The invite code, or undefined if not stored
   */
  async getInviteCode(sessionName: string): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_PREFIX + sessionName);
  }

  /**
   * Delete a stored invite code for a session.
   *
   * @param sessionName - The session identifier
   */
  async deleteInviteCode(sessionName: string): Promise<void> {
    await this.context.secrets.delete(SECRET_PREFIX + sessionName);
  }
}
