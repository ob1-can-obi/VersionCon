import * as vscode from 'vscode';
import type { SavedSession } from '../types/session.js';

/** Maximum number of sessions kept in history (D-08: last 3-5 sessions). */
const MAX_HISTORY = 5;

/** globalState key for persisted session history. */
const STORAGE_KEY = 'versioncon.sessionHistory';

/**
 * Manages session history in VS Code globalState for one-click reconnect (NET-04).
 *
 * Sessions are stored as an array ordered by most-recently-used first.
 * Duplicate entries (same hostIp + port) are deduplicated on insert.
 *
 * Threat model T-01-11: No invite codes are stored in history —
 * only IP, port, session name, display name, and timestamp.
 */
export class SessionHistory {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Retrieve the current session history, most recent first.
   */
  getHistory(): SavedSession[] {
    return this.context.globalState.get<SavedSession[]>(STORAGE_KEY, []);
  }

  /**
   * Add or update a session entry in history.
   *
   * If an entry with the same hostIp + port already exists, it is removed
   * before the new entry is prepended (deduplication). History is capped
   * at MAX_HISTORY entries.
   *
   * @param entry - Session data (lastConnected is set automatically)
   */
  async addEntry(entry: Omit<SavedSession, 'lastConnected'>): Promise<void> {
    const history = this.getHistory();

    // Remove duplicate by hostIp + port
    const filtered = history.filter(
      (s) => !(s.hostIp === entry.hostIp && s.port === entry.port)
    );

    // Prepend new entry with current timestamp
    const updated: SavedSession[] = [
      { ...entry, lastConnected: Date.now() },
      ...filtered,
    ].slice(0, MAX_HISTORY);

    await this.context.globalState.update(STORAGE_KEY, updated);
  }

  /**
   * Remove a specific session entry by hostIp + port.
   */
  async removeEntry(hostIp: string, port: number): Promise<void> {
    const history = this.getHistory();
    const filtered = history.filter(
      (s) => !(s.hostIp === hostIp && s.port === port)
    );
    await this.context.globalState.update(STORAGE_KEY, filtered);
  }

  /**
   * Clear all session history.
   */
  async clearHistory(): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, []);
  }
}
