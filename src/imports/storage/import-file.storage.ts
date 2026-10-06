// Keys identify uploaded workbooks independently of the storage backend.
export abstract class ImportFileStorage {
  abstract save(buffer: Buffer): Promise<string>;
  abstract read(key: string): Promise<Buffer>;
  abstract delete(key: string): Promise<void>;
}
