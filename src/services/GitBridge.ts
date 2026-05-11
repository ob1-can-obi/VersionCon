import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Phase 4.3 Wave 4 — GitBridge service.
 *
 * Shell-safe wrapper around the `git` CLI. Used by versioncon.exportToGitRemote
 * (SC-6) and versioncon.importFromGitRemote (SC-7). All `git` invocations go
 * through `child_process.spawn` with `shell: false` and an argv array — no
 * string interpolation, no shell parsing. User-supplied URL and branch-name
 * inputs are pre-validated against an allowlist regex before they reach spawn
 * (T-04.3-03 command-injection mitigation).
 *
 * Threat model references:
 *   - T-04.3-03 (tampering / command injection): mitigated by validateUrl +
 *     validateBranchName allowlist regexes AND by argv-only spawn (shell:false).
 *   - T-04.3-13 (tampering / malicious .git/hooks in imported tree): mitigated
 *     by stripping .git/ after a successful clone in importFromRemote.
 *
 * Two-layer permission gating (T-04.3-04) is enforced by the EXTENSION.TS
 * command handler — GitBridge itself trusts its caller for the host/admin
 * gate. validateUrl / validateBranchName are defensive (re-applied here in
 * exportToRemote / importFromRemote even though the handler validates them).
 */

/** https://, git@host:, and file:// URLs are allowed. Reject everything else. */
const URL_ALLOWLIST: RegExp[] = [
  /^https:\/\/[A-Za-z0-9._-]+(?::[0-9]+)?\/[A-Za-z0-9._/-]+(?:\.git)?$/,
  /^git@[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+(?:\.git)?$/,
  /^file:\/\/(?:\/[A-Za-z0-9._/-]+)+(?:\.git)?$/,
];

/** Allowed branch-name characters mirror git's own surface (sans spaces). */
const BRANCH_NAME_ALLOWLIST = /^[A-Za-z0-9._/-]{1,128}$/;

/** Maximum URL length we will consider (defensive — keeps regex bounded). */
const MAX_URL_LENGTH = 2048;

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExportOpts {
  /** Absolute path to .versioncon/branches/{branch}/. */
  branchDir: string;
  /** Remote URL — caller MUST pre-validate via validateUrl. */
  remoteUrl: string;
  /** Branch name on remote — caller MUST pre-validate via validateBranchName. */
  branchOnRemote: string;
  /** Commit message — arbitrary string, passed via spawn argv (no shell). */
  commitMessage: string;
  /** Streaming output callback — receives one logical line per call. */
  onOutput: (line: string) => void;
}

export interface ImportOpts {
  remoteUrl: string;
  branchOnRemote: string;
  /** Absolute path where the cloned tree will land. Must NOT pre-exist. */
  destDir: string;
  onOutput: (line: string) => void;
}

export class GitBridge {
  /**
   * Returns true iff `url` matches one of the URL_ALLOWLIST patterns.
   * T-04.3-03 mitigation: anything outside https://, git@host:, file:// is
   * rejected before it ever reaches spawn.
   */
  validateUrl(url: string): boolean {
    if (typeof url !== 'string') return false;
    if (url.length === 0 || url.length > MAX_URL_LENGTH) return false;
    return URL_ALLOWLIST.some((re) => re.test(url));
  }

  /**
   * Returns true iff `name` matches BRANCH_NAME_ALLOWLIST.
   * T-04.3-03 mitigation: rejects spaces, shell metacharacters, and oversize
   * inputs. Mirrors git's branch-name surface conservatively.
   */
  validateBranchName(name: string): boolean {
    if (typeof name !== 'string') return false;
    return BRANCH_NAME_ALLOWLIST.test(name);
  }

  /**
   * Spawn `git` with the given argv. shell:false is EXPLICIT — argv elements
   * are passed as literals; no shell parsing occurs. Resolves with the exit
   * code + captured stdout/stderr. Never throws on non-zero exit; only throws
   * if spawn itself fails (e.g. git not on PATH).
   */
  async runGit(args: string[], cwd: string): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      // T-04.3-03: shell:false is EXPLICIT. Do not change to true.
      const child = spawn('git', args, { cwd, shell: false });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (b: Buffer) => {
        stdout += b.toString();
      });
      child.stderr?.on('data', (b: Buffer) => {
        stderr += b.toString();
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    });
  }

  /**
   * SC-6: run `git init` + `git add .` + `git commit -m <msg>` +
   * `git remote add origin <url>` + `git push -u origin <branch>` inside
   * `opts.branchDir`. All inputs go through spawn argv — no shell parsing.
   *
   * `git init` is idempotent on an existing repo. `git remote add origin`
   * falls back to `git remote set-url origin` if origin already exists.
   * `git commit` exiting 1 with "nothing to commit" is treated as soft
   * success so a re-run after a no-op edit still pushes the existing HEAD.
   */
  async exportToRemote(opts: ExportOpts): Promise<void> {
    // Defense-in-depth: caller is expected to have validated already.
    if (!this.validateUrl(opts.remoteUrl)) {
      throw new Error('Invalid remote URL');
    }
    if (!this.validateBranchName(opts.branchOnRemote)) {
      throw new Error('Invalid branch name');
    }
    const cwd = opts.branchDir;
    const run = async (args: string[]): Promise<GitResult> => {
      opts.onOutput(`$ git ${args.join(' ')}`);
      const r = await this.runGit(args, cwd);
      if (r.stdout) opts.onOutput(r.stdout);
      if (r.stderr) opts.onOutput(r.stderr);
      opts.onOutput(`[exit ${r.code}]`);
      return r;
    };

    let r = await run(['init']);
    if (r.code !== 0) {
      throw new Error(`git init failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }

    r = await run(['add', '.']);
    if (r.code !== 0) {
      throw new Error(`git add failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }

    // commit message is passed as a discrete argv element — never interpolated.
    r = await run(['commit', '-m', opts.commitMessage]);
    if (r.code !== 0) {
      // Soft-success for "nothing to commit" — different git versions put the
      // phrase on stdout vs stderr, so check both. Also handle the helpful
      // "Please tell me who you are" error (deviation Rule 2 per plan).
      const combined = `${r.stdout}\n${r.stderr}`;
      if (!/nothing to commit/i.test(combined)) {
        if (/Please tell me who you are/i.test(combined)) {
          throw new Error(
            'git commit failed: git user.email / user.name are not configured. Run `git config --global user.email "you@example.com"` and `git config --global user.name "Your Name"` then retry.',
          );
        }
        throw new Error(
          `git commit failed: ${r.stderr.trim() || r.stdout.trim()}`,
        );
      }
    }

    // Add origin; if it already exists, switch to set-url.
    r = await run(['remote', 'add', 'origin', opts.remoteUrl]);
    if (r.code !== 0) {
      r = await run(['remote', 'set-url', 'origin', opts.remoteUrl]);
      if (r.code !== 0) {
        throw new Error(
          `git remote add/set-url failed: ${r.stderr.trim() || r.stdout.trim()}`,
        );
      }
    }

    r = await run(['push', '-u', 'origin', opts.branchOnRemote]);
    if (r.code !== 0) {
      throw new Error(`git push failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }

  /**
   * SC-7: clone `opts.remoteUrl` at branch `opts.branchOnRemote` into
   * `opts.destDir`. Strips the resulting `.git/` directory so the cloned
   * tree becomes a plain VersionCon branch dir (T-04.3-13 mitigation —
   * prevents malicious .git/hooks from running on subsequent operations).
   *
   * `opts.destDir` MUST NOT pre-exist — `git clone` requires an empty target
   * and we want explicit failure rather than silent merge with existing data.
   */
  async importFromRemote(opts: ImportOpts): Promise<void> {
    if (!this.validateUrl(opts.remoteUrl)) {
      throw new Error('Invalid remote URL');
    }
    if (!this.validateBranchName(opts.branchOnRemote)) {
      throw new Error('Invalid branch name');
    }

    // Refuse to clobber an existing destination.
    let destExists = true;
    try {
      await fs.access(opts.destDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        destExists = false;
      } else {
        throw err;
      }
    }
    if (destExists) {
      throw new Error(`Destination already exists: ${opts.destDir}`);
    }

    await fs.mkdir(path.dirname(opts.destDir), { recursive: true });

    const args = [
      'clone',
      '--branch',
      opts.branchOnRemote,
      '--single-branch',
      opts.remoteUrl,
      opts.destDir,
    ];
    opts.onOutput(`$ git ${args.join(' ')}`);
    const r = await this.runGit(args, path.dirname(opts.destDir));
    if (r.stdout) opts.onOutput(r.stdout);
    if (r.stderr) opts.onOutput(r.stderr);
    opts.onOutput(`[exit ${r.code}]`);
    if (r.code !== 0) {
      throw new Error(`git clone failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }

    // T-04.3-13: strip .git/ so the imported tree cannot run hooks on
    // subsequent git operations against this VersionCon branch dir.
    await fs.rm(path.join(opts.destDir, '.git'), { recursive: true, force: true });
  }
}
