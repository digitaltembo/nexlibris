/**
 * Minimal persistence that a library backend is built on. Paths are
 * slash-separated and relative to the library's root.
 */
export interface Storage {
  readText(path: string): Promise<string | undefined>;
  writeText(path: string, text: string): Promise<void>;
  appendText(path: string, text: string): Promise<void>;
  readBlob(path: string): Promise<Blob | undefined>;
  writeBlob(path: string, blob: Blob): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export class MemoryStorage implements Storage {
  private readonly files = new Map<string, Blob>();

  async readText(path: string) {
    return this.files.get(path)?.text();
  }
  async writeText(path: string, text: string) {
    this.files.set(path, new Blob([text]));
  }
  async appendText(path: string, text: string) {
    const existing = this.files.get(path);
    this.files.set(path, new Blob(existing ? [existing, text] : [text]));
  }
  async readBlob(path: string) {
    return this.files.get(path);
  }
  async writeBlob(path: string, blob: Blob) {
    this.files.set(path, blob);
  }
  async exists(path: string) {
    return this.files.has(path);
  }
}
