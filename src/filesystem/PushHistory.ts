import * as fs from 'fs/promises';
import * as path from 'path';
import type { PushRecord } from '../types/push.js';

/**
 * Persists push records to push-history.json and manages
 * file snapshots in push-snapshots/{pushId}/{relativePath}.
 */
export class PushHistory {
  private readonly historyFile: string;
  private readonly snapshotsDir: string;
  private records: PushRecord[] = [];

  constructor(private readonly versionconDir: string) {
    this.historyFile = path.join(versionconDir, 'push-history.json');
    this.snapshotsDir = path.join(versionconDir, 'push-snapshots');
  }

  /** Load push history from disk. Call once at startup. */
  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.historyFile, 'utf-8');
      this.records = JSON.parse(data);
    } catch {
      this.records = [];
    }
  }

  /** Save current records to disk. */
  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.historyFile), { recursive: true });
    await fs.writeFile(this.historyFile, JSON.stringify(this.records, null, 2));
  }

  /** Add a push record and persist. */
  async addRecord(record: PushRecord): Promise<void> {
    this.records.push(record);
    await this.save();
  }

  /** Get all records (newest first). */
  getRecords(): PushRecord[] {
    return [...this.records].reverse();
  }

  /** Get a record by ID. */
  getRecord(pushId: string): PushRecord | undefined {
    return this.records.find(r => r.id === pushId);
  }

  /**
   * Get the most recent push record (regardless of revert state).
   * Used by SessionHost.sync-request to populate latestPushId so reconnecting
   * clients can seed their sync state correctly (PUSH-09).
   */
  getLatestRecord(): PushRecord | undefined {
    return this.records.length > 0 ? this.records[this.records.length - 1] : undefined;
  }

  /** Mark a push record as reverted. */
  async markReverted(pushId: string, revertedFiles?: string[]): Promise<void> {
    const record = this.records.find(r => r.id === pushId);
    if (record) {
      record.reverted = true;
      if (revertedFiles) {
        record.revertedFiles = revertedFiles;
      }
      await this.save();
    }
  }

  /**
   * Save a pre-push snapshot of a file's content.
   * Used for revert — stores the branch version before it was overwritten.
   */
  async saveSnapshot(pushId: string, relativePath: string, content: string): Promise<void> {
    const snapshotPath = path.join(this.snapshotsDir, pushId, relativePath);
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(snapshotPath, content);
  }

  /**
   * Read a snapshot file for a given push and relative path.
   * Returns null if the snapshot doesn't exist (file was newly added).
   */
  async readSnapshot(pushId: string, relativePath: string): Promise<string | null> {
    const snapshotPath = path.join(this.snapshotsDir, pushId, relativePath);
    try {
      return await fs.readFile(snapshotPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /** Check if a snapshot exists for a given push/path. */
  async hasSnapshot(pushId: string, relativePath: string): Promise<boolean> {
    const snapshotPath = path.join(this.snapshotsDir, pushId, relativePath);
    try {
      await fs.access(snapshotPath);
      return true;
    } catch {
      return false;
    }
  }
}
