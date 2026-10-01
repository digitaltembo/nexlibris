import type { Catalog, DeviceTarget, RemoteFile } from '../../devices/types';

interface Entry {
  name: string;
  size: number;
  isDirectory: boolean;
}

interface Status {
  version?: string;
  device?: string;
  mode?: string;
}

/**
 * A CrossPoint reader in File Transfer mode, through its web server (see
 * crosspoint-reader/docs/webserver-endpoints.md). It serves plain HTTP, so a
 * page served over HTTPS can't reach it: the browser blocks mixed content.
 */
export class CrossPointTarget implements DeviceTarget {
  readonly base: string;

  constructor(
    address: string,
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {
    const trimmed = address.trim().replace(/\/+$/, '');
    this.base = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  }

  async connect() {
    const status = (await (await this.request('/api/status', { signal: AbortSignal.timeout(8000) })).json()) as Status;
    const description = [status.device ?? 'CrossPoint', status.version && `firmware ${status.version}`].filter(Boolean);
    return { description: description.join(', ') };
  }

  async list(folder: string): Promise<RemoteFile[]> {
    return (await this.entries(folder))
      .filter((e) => !e.isDirectory)
      .map((e) => ({ path: join(folder, e.name), size: e.size }));
  }

  async ensureFolder(folder: string) {
    let parent = '/';
    for (const name of folder.split('/').filter(Boolean)) {
      const exists = (await this.entries(parent)).some((e) => e.isDirectory && e.name === name);
      if (!exists) await this.request('/mkdir', { method: 'POST', body: new URLSearchParams({ name, path: parent }) });
      parent = join(parent, name);
    }
  }

  async upload(path: string, data: Blob) {
    const slash = path.lastIndexOf('/');
    const form = new FormData();
    // A File, so the name is set however FormData treats a Blob's filename argument.
    form.append('file', new File([data], path.slice(slash + 1), { type: data.type }));
    await this.request(`/upload?path=${encodeURIComponent(path.slice(0, slash) || '/')}`, { method: 'POST', body: form });
  }

  async remove(path: string) {
    // One path per request: the `paths` list form was refused by the simulator.
    await this.request('/delete', { method: 'POST', body: new URLSearchParams({ path }) });
  }

  /** The reader's saved OPDS servers (firmware with multi-server support). */
  async listCatalogs(): Promise<Catalog[]> {
    const servers = (await (await this.request('/api/opds')).json()) as { name?: string; url?: string }[];
    return servers.map((s) => ({ name: s.name ?? '', url: s.url ?? '' }));
  }

  async addCatalog({ name, url }: Catalog) {
    await this.request('/api/opds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url }),
    });
  }

  private async entries(folder: string): Promise<Entry[]> {
    return (await (await this.request(`/api/files?path=${encodeURIComponent(folder)}`)).json()) as Entry[];
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(this.base + path, init);
    } catch (e) {
      throw new Error(this.unreachable(e));
    }
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).trim();
      throw new Error(`The reader refused ${path.split('?')[0]}: ${text || `${response.status} ${response.statusText}`}`);
    }
    return response;
  }

  private unreachable(e: unknown) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      return `${this.base} didn't answer. Is the reader in File Transfer mode, on the same network?`;
    }
    if (typeof location !== 'undefined' && location.protocol === 'https:' && this.base.startsWith('http:')) {
      return `Couldn't reach ${this.base}: this page is served over HTTPS, and browsers block it from plain-HTTP devices. Use nexlibris from localhost to sync.`;
    }
    return `Couldn't reach ${this.base}. Is the reader in File Transfer mode, on the same network?`;
  }
}

const join = (folder: string, name: string) => `${folder.replace(/\/+$/, '')}/${name}`;
