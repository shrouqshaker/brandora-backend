import { ConfigService } from '@nestjs/config';
import fs from 'node:fs/promises';
import { mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalImportFileStorage } from '../../src/imports/storage/local-import-file.storage';

describe('Local import file storage', () => {
  let directory: string;
  let storage: LocalImportFileStorage;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'brandora-imports-storage-'));
    storage = new LocalImportFileStorage(
      new ConfigService({ IMPORT_STORAGE_DIR: directory }),
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const key of await readdir(directory)) await storage.delete(key);
    await rmdir(directory);
  });

  it('saves unique keys, retains bytes, and deletes idempotently', async () => {
    const first = await storage.save(Buffer.from('first workbook'));
    const second = await storage.save(Buffer.from('second workbook'));
    expect(first).not.toEqual(second);
    expect(await storage.read(first)).toEqual(Buffer.from('first workbook'));
    expect(await storage.read(second)).toEqual(Buffer.from('second workbook'));
    await storage.delete(first);
    await storage.delete(first);
    expect(await readdir(directory)).toEqual([second]);
  });

  it('removes an incomplete file when writing fails after partial bytes', async () => {
    const originalOpen = fs.open;
    jest.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      const originalWrite = handle.writeFile.bind(handle);
      jest.spyOn(handle, 'writeFile').mockImplementation(async () => {
        await originalWrite(Buffer.from('partial workbook'));
        throw new Error('Disk write failed');
      });
      return handle;
    });
    await expect(
      storage.save(Buffer.from('complete workbook')),
    ).rejects.toThrow('Disk write failed');
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    '../outside.xlsx',
    '..\\outside.xlsx',
    '/tmp/outside.xlsx',
    'C:\\outside.xlsx',
    'filename.xlsx',
  ])('rejects read/delete for invalid key %s', async (key) => {
    expect(() => storage.read(key)).toThrow('Invalid import file key');
    await expect(storage.delete(key)).rejects.toThrow(
      'Invalid import file key',
    );
    expect(await readdir(directory)).toEqual([]);
  });
});
