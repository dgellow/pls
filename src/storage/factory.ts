import type { Storage, StorageOptions } from '../types.ts';
import { LocalStorage } from './local.ts';
import { GitHubStorage } from './github.ts';
import { PlsError } from '../types.ts';

export type StorageType = 'local' | 'github';

export function createStorage(
  type: StorageType = 'local',
  options: StorageOptions = {},
): Storage {
  switch (type) {
    case 'local':
      return new LocalStorage(options);
    case 'github':
      return new GitHubStorage(options);
    default:
      throw new PlsError(
        `Unknown storage type: ${type}`,
        'INVALID_STORAGE_TYPE',
      );
  }
}
