import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Whether the module at `url` is the program being run. npm installs a bin
 * as a symlink, so argv[1] is resolved to its real path before comparing.
 */
export function isMain(url: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
