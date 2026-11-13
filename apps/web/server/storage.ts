// Private object store for document bytes. The only adapter is a directory on a private volume outside the web root.
// Keys are server-generated 32-character hex strings and every method validates them, so no caller input ever reaches a path.
// Layout under the root:  quarantine/<key>   bytes received, not yet trusted, never served
//                         objects/<aa>/<key>  bytes that passed validation, served only through the authorized download
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const STORAGE_KEY_PATTERN = /^[0-9a-f]{32}$/;
export const newStorageKey = () => randomBytes(16).toString('hex');

export interface StoredFile { key: string; size: number; modifiedMs: number }

export interface ObjectStore {
  /** Writes bytes to quarantine. Fails if the key already exists. */
  putQuarantine(key: string, bytes: Uint8Array): Promise<void>;
  readQuarantine(key: string): Promise<Buffer>;
  /** Moves a quarantined file into the served area. Fails if an object with that key exists. */
  promote(key: string): Promise<void>;
  read(key: string): Promise<Buffer>;
  /** Removes an object or a quarantined file. A missing file is not an error. */
  remove(key: string): Promise<void>;
  removeQuarantine(key: string): Promise<void>;
  list(): Promise<{ objects: StoredFile[]; quarantine: StoredFile[] }>;
}

function checkKey(key: string): string {
  if (!STORAGE_KEY_PATTERN.test(key)) throw new Error('invalid storage key');
  return key;
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export class FileObjectStore implements ObjectStore {
  readonly root: string;
  private ready: Promise<void> | null = null;

  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new Error('document storage root must be an absolute path');
    this.root = path.resolve(root);
  }

  private async init(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(path.join(this.root, 'quarantine'), { recursive: true, mode: DIR_MODE });
      await mkdir(path.join(this.root, 'objects'), { recursive: true, mode: DIR_MODE });
    })().catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  private quarantinePath(key: string) { return path.join(this.root, 'quarantine', checkKey(key)); }
  private objectPath(key: string) { return path.join(this.root, 'objects', checkKey(key).slice(0, 2), key); }

  async putQuarantine(key: string, bytes: Uint8Array): Promise<void> {
    await this.init();
    const target = this.quarantinePath(key);
    // wx: never overwrite. NOFOLLOW: never write through a planted link.
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(target).catch(() => undefined);
      throw error;
    }
    await handle.close();
  }

  private async readFrom(file: string): Promise<Buffer> {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async readQuarantine(key: string): Promise<Buffer> {
    await this.init();
    return this.readFrom(this.quarantinePath(key));
  }

  async promote(key: string): Promise<void> {
    await this.init();
    const from = this.quarantinePath(key);
    const to = this.objectPath(key);
    await mkdir(path.dirname(to), { recursive: true, mode: DIR_MODE });
    // rename() would replace an existing file; keys are random, but refuse to overwrite regardless.
    try {
      await stat(to);
      throw new Error('object already exists');
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
    await rename(from, to);
  }

  async read(key: string): Promise<Buffer> {
    await this.init();
    return this.readFrom(this.objectPath(key));
  }

  async remove(key: string): Promise<void> {
    await this.init();
    for (const file of [this.objectPath(key), this.quarantinePath(key)]) {
      await unlink(file).catch((error) => {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      });
    }
  }

  async removeQuarantine(key: string): Promise<void> {
    await this.init();
    await unlink(this.quarantinePath(key)).catch((error) => {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    });
  }

  async list(): Promise<{ objects: StoredFile[]; quarantine: StoredFile[] }> {
    await this.init();
    const describe = async (file: string, key: string): Promise<StoredFile | null> => {
      try {
        const s = await stat(file);
        return s.isFile() ? { key, size: s.size, modifiedMs: s.mtimeMs } : null;
      } catch {
        return null;
      }
    };
    const quarantine: StoredFile[] = [];
    for (const name of await readdir(path.join(this.root, 'quarantine'))) {
      if (!STORAGE_KEY_PATTERN.test(name)) continue;
      const f = await describe(this.quarantinePath(name), name);
      if (f) quarantine.push(f);
    }
    const objects: StoredFile[] = [];
    for (const dir of await readdir(path.join(this.root, 'objects'))) {
      if (!/^[0-9a-f]{2}$/.test(dir)) continue;
      for (const name of await readdir(path.join(this.root, 'objects', dir))) {
        if (!STORAGE_KEY_PATTERN.test(name) || name.slice(0, 2) !== dir) continue;
        const f = await describe(this.objectPath(name), name);
        if (f) objects.push(f);
      }
    }
    return { objects, quarantine };
  }
}
