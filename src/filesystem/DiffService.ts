import type { PushFileEntry } from '../types/push.js';

/**
 * Simple line-level diff computation.
 * No external dependencies — just array comparison.
 */
export class DiffService {
  /**
   * Compute line-level diff stats between two content strings.
   * Returns added/removed line counts.
   */
  computeLineDiff(original: string, modified: string): { addedLines: number; removedLines: number } {
    const origLines = original ? original.split('\n') : [];
    const modLines = modified ? modified.split('\n') : [];

    const origSet = new Set(origLines);
    const modSet = new Set(modLines);

    let addedLines = 0;
    let removedLines = 0;

    for (const line of modLines) {
      if (!origSet.has(line)) {
        addedLines++;
      }
    }

    for (const line of origLines) {
      if (!modSet.has(line)) {
        removedLines++;
      }
    }

    return { addedLines, removedLines };
  }

  /**
   * Determine the status of a file given original and modified content.
   */
  determineStatus(originalExists: boolean, modifiedExists: boolean): PushFileEntry['status'] {
    if (!originalExists && modifiedExists) return 'added';
    if (originalExists && !modifiedExists) return 'deleted';
    return 'modified';
  }
}
