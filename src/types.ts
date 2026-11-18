// Entity types for the forge. Every module imports these; nobody redefines them.
// See docs/CONTRACT.md for the full shared contract.

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  repoId: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Label[];
  user: User;
  created_at: string;
  updated_at: string;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  repoId: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  mergeable: boolean;
  user: User;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: User;
  private: boolean;
  description: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  /** 'refs/heads/main' -> commit sha */
  refs: Map<string, string>;
  /** sha -> raw object bytes ("type <len>\0<payload>", NOT zlib-compressed) */
  objects: Map<string, Buffer>;
  /** Shared issues+PRs counter, starts at 1. */
  nextNumber: number;
  /** Label id counter, starts at 1. */
  nextLabelId: number;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
}

/** The fixed viewer the bearer token names (kit wire.ts SCENARIO_SEED, same every trial). */
export const VIEWER: User = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

/** Another seeded user; repos under this login are never the viewer's (404, never 403). */
export const STRANGER: User = {
  id: 1002,
  login: 'olgabauer',
  name: 'olga bauer',
  email: 'olgabauer@example.invalid',
};

export const TEAMMATE: User = {
  id: 1001,
  login: 'quinnkeller',
  name: 'quinn keller',
  email: 'quinnkeller@example.invalid',
};

/** Deterministic timestamp for all stored state: MAKEFUN_TRIAL_NOW or the fixed epoch. */
export function trialNow(): string {
  return process.env.MAKEFUN_TRIAL_NOW ?? '2025-01-01T00:00:00Z';
}

/** Unix seconds of trialNow(), for git commit timestamps. */
export function trialNowSeconds(): number {
  const ms = Date.parse(trialNow());
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 1735689600;
}
