export interface Release {
  version: string;
  tag: string;
  sha: string;
  createdAt: Date;
  notes?: string;
  url?: string;
}

export interface Commit {
  sha: string;
  message: string;
  author: string;
  date: Date;
}

export interface VersionBump {
  from: string;
  to: string;
  type: 'major' | 'minor' | 'patch';
  commits: Commit[];
}

export interface StorageOptions {
  owner?: string;
  repo?: string;
  token?: string;
  cacheTTL?: number;
}

export interface Storage {
  getLastRelease(): Promise<Release | null>;
  saveRelease(release: Release): Promise<void>;
  listReleases(): Promise<Release[]>;
}

export class PlsError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'PlsError';
  }
}
