// Keys identify uploaded workbooks independently of the storage backend.
export abstract class ImportFileStorage {
  abstract save(buffer: Buffer): Promise<string>;
  abstract read(key: string): Promise<Buffer>;
  abstract delete(key: string): Promise<void>;
  // Immutable JSON sidecars are located using the retained workbook's key.
  abstract saveValidationResult(key: string, buffer: Buffer): Promise<void>;
  abstract readValidationResult(key: string): Promise<Buffer>;
  abstract deleteValidationResult(key: string): Promise<void>;
}
