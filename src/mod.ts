// Main module exports for programmatic usage

export * from './types.ts';
export * from './storage/mod.ts';
export * from './core/mod.ts';
export * from './manifest/mod.ts';
export * from './versions/mod.ts';
export { VERSION } from './version_info.ts';

// Convenience export for creating a full release pipeline
import { createStorage, type StorageType } from './storage/mod.ts';
import { Detector, ReleaseManager, Version } from './core/mod.ts';
import type { Release, StorageOptions } from './types.ts';

export interface PlsOptions extends StorageOptions {
  storage?: StorageType;
  dryRun?: boolean;
}

export async function createRelease(options: PlsOptions = {}): Promise<Release | null> {
  const storage = createStorage(options.storage || 'local', options);
  const detector = new Detector();
  const version = new Version();
  const releaseManager = new ReleaseManager(storage);

  // Get last release
  const lastRelease = await storage.getLastRelease();

  // Detect changes
  const changes = await detector.detectChanges(lastRelease);
  if (!changes.hasChanges) {
    return null;
  }

  // Determine version bump
  const bump = await version.determineVersionBump(
    lastRelease?.version || null,
    changes.commits,
  );
  if (!bump) {
    return null;
  }

  // Create release
  const release = await releaseManager.createRelease(
    bump,
    changes.currentSha,
    options.dryRun || false,
  );

  return release;
}
