import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ImportFileStorage } from './import-file.storage';

@Injectable()
export class LocalImportFileStorage extends ImportFileStorage {
  private readonly directory: string;

  constructor(config: ConfigService) {
    super();
    this.directory = resolve(
      config.get<string>('IMPORT_STORAGE_DIR') || '.storage/imports',
    );
  }

  async save(buffer: Buffer): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    const key = `${randomUUID()}.xlsx`;
    const path = this.pathFor(key);
    // Exclusive creation prevents overwriting an existing upload.
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(buffer);
      await handle.close();
    } catch (error: unknown) {
      try {
        await handle.close();
      } finally {
        await this.delete(key);
      }
      throw error;
    }
    return key;
  }

  read(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private pathFor(key: string): string {
    // Only adapter-generated keys are accepted; filenames never become paths.
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.xlsx$/.test(
        key,
      )
    ) {
      throw new Error('Invalid import file key');
    }
    return join(this.directory, key);
  }

  async saveValidationResult(key: string, buffer: Buffer): Promise<void> {
    const path = this.validationPathFor(key);
    await mkdir(this.directory, { recursive: true });
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(buffer);
      await handle.close();
    } catch (error: unknown) {
      try {
        await handle.close();
      } finally {
        await this.deleteValidationResult(key);
      }
      throw error;
    }
  }

  readValidationResult(key: string): Promise<Buffer> {
    return readFile(this.validationPathFor(key));
  }

  async deleteValidationResult(key: string): Promise<void> {
    try {
      await unlink(this.validationPathFor(key));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private validationPathFor(key: string): string {
    return this.pathFor(key).replace(/\.xlsx$/, '.validation.json');
  }
}
