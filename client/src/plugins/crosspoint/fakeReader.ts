import { CrossPointTarget, type FontFamily, type ReaderSetting } from './client';

/**
 * A CrossPoint reader's web server over an in-memory SD card, for tests and stories: files,
 * folders, settings and fonts, answering as crosspoint-reader's CrossPointWebServer does
 * (hidden dot entries left out of listings, `/mkdir` refusing a folder that exists, fonts'
 * family read from the form). Not a full model of the reader.
 */
export interface FakeReader {
  reader: CrossPointTarget;
  files: Map<string, Blob>;
  folders: Set<string>;
  settings: ReaderSetting[];
  requests: string[];
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const join = (folder: string, name: string) => `${folder.replace(/\/+$/, '')}/${name}`;
const FONT_ROOTS = ['/.fonts', '/fonts'];

export function fakeReader(
  initial: { files?: Record<string, Blob>; settings?: ReaderSetting[]; delay?: number } = {},
): FakeReader {
  const files = new Map(Object.entries(initial.files ?? {}));
  const folders = new Set<string>(['/']);
  for (const path of files.keys()) for (let p = parentOf(path); p !== '/'; p = parentOf(p)) folders.add(p);
  const settings = initial.settings ?? [
    { key: 'sleepScreen', name: 'Sleep Screen', category: 'Display', type: 'enum', value: 0, options: ['Dark', 'Light', 'Custom', 'Cover', 'Cover + Custom', 'None', 'Quick Resume', 'Transparent'] },
    { key: 'fontFamily', name: 'Reader Font Family', category: 'Reader', type: 'enum', value: 0, options: ['Noto Serif', 'Noto Sans'] },
  ];
  const requests: string[] = [];

  /** Font families on the card, as the reader's registry finds them. */
  const families = (): FontFamily[] => {
    const found = new Map<string, FontFamily>();
    for (const root of FONT_ROOTS) {
      for (const folder of folders) {
        if (parentOf(folder) !== root || found.has(nameOf(folder))) continue;
        const inside = [...files].filter(([path]) => parentOf(path) === folder);
        if (!inside.length) continue;
        const sizes = inside.map(([path]) => Number(/_(\d+)\.cpfont$/i.exec(path)?.[1] ?? 0));
        found.set(nameOf(folder), {
          name: nameOf(folder),
          sizes: [...new Set(sizes)].sort((a, b) => a - b),
          files: inside.map(([path, data]) => ({ name: nameOf(path), size: data.size })),
        });
      }
    }
    return [...found.values()];
  };
  /** The font setting's options follow the installed families, as on the reader. */
  const fontSetting = () => {
    const setting = settings.find((s) => s.key === 'fontFamily');
    if (!setting) return;
    const current = setting.options?.[Number(setting.value)];
    setting.options = ['Noto Serif', 'Noto Sans', ...families().map((f) => f.name)];
    setting.value = Math.max(0, setting.options.indexOf(current ?? ''));
  };

  const listing = (folder: string) => [
    ...[...folders]
      .filter((f) => f !== '/' && parentOf(f) === folder)
      .map((f) => ({ name: nameOf(f), size: 0, isDirectory: true, isEpub: false })),
    ...[...files]
      .filter(([f]) => parentOf(f) === folder)
      .map(([f, data]) => ({ name: nameOf(f), size: data.size, isDirectory: false, isEpub: f.endsWith('.epub') })),
  ].filter((e) => !e.name.startsWith('.'));

  const fetchFn = (async (input: string, init?: RequestInit) => {
    if (initial.delay) await new Promise((resolve) => setTimeout(resolve, initial.delay));
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url.pathname}`);
    const form = init?.body instanceof URLSearchParams ? init.body : undefined;
    const path = url.searchParams.get('path') ?? '/';
    switch (`${method} ${url.pathname}`) {
      case 'GET /api/status':
        return Response.json({ version: '1.2.0', mode: 'STA', device: 'X4' });
      case 'GET /api/files':
        return Response.json(listing(path));
      case 'GET /download': {
        const data = files.get(path);
        return data ? new Response(data) : new Response('File not found', { status: 404 });
      }
      case 'POST /mkdir': {
        const folder = join(form!.get('path') ?? '/', form!.get('name')!);
        if (folders.has(folder) || files.has(folder)) return new Response('Folder already exists', { status: 400 });
        if (!folders.has(parentOf(folder))) return new Response('Failed to create folder', { status: 500 });
        folders.add(folder);
        return new Response('Folder created');
      }
      case 'POST /upload': {
        const file = (init!.body as FormData).get('file') as File;
        if (!folders.has(path)) return new Response('Failed to create file', { status: 500 });
        files.set(join(path, file.name), file);
        return new Response(`File uploaded successfully: ${file.name}`);
      }
      case 'POST /move': {
        const from = form!.get('path')!;
        const dest = form!.get('dest')!;
        const data = files.get(from);
        const to = join(dest, nameOf(from));
        if (!data) return new Response('Source not found', { status: 404 });
        if (!folders.has(dest)) return new Response('Destination folder not found', { status: 400 });
        if (files.has(to)) return new Response('Destination already exists', { status: 409 });
        files.delete(from);
        files.set(to, data);
        return new Response('Moved');
      }
      case 'POST /rename': {
        const from = form!.get('path')!;
        const to = join(parentOf(from), form!.get('name')!);
        const data = files.get(from);
        if (!data) return new Response('Source not found', { status: 404 });
        if (files.has(to)) return new Response('Destination already exists', { status: 409 });
        files.delete(from);
        files.set(to, data);
        return new Response('Renamed');
      }
      case 'POST /delete': {
        const target = form!.get('path')!;
        if (files.delete(target)) return new Response('Deleted');
        if (folders.has(target)) {
          if ([...files.keys(), ...folders].some((p) => p !== target && parentOf(p) === target)) {
            return new Response('Folder is not empty', { status: 400 });
          }
          folders.delete(target);
          return new Response('Deleted');
        }
        return new Response('Not found', { status: 404 });
      }
      case 'GET /api/settings':
        fontSetting();
        return Response.json(settings);
      case 'POST /api/settings': {
        const values = JSON.parse(init!.body as string) as Record<string, number | string>;
        for (const [key, value] of Object.entries(values)) {
          const setting = settings.find((s) => s.key === key);
          if (setting) setting.value = value;
        }
        return new Response(`Applied ${Object.keys(values).length} setting(s)`);
      }
      case 'GET /api/fonts':
        return Response.json({ maxFamilies: 128, families: families() });
      case 'POST /api/fonts/upload': {
        const body = init!.body as FormData;
        // The reader reads the family as the file starts, so it must come first.
        const [first] = [...body.keys()];
        const family = body.get('family');
        const file = body.get('file') as File;
        const head = new TextDecoder().decode(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
        if (first !== 'family' || typeof family !== 'string' || !/^[\w-]+$/.test(family) || head !== 'CPFONT\0\0') {
          return Response.json({ error: 'Invalid .cpfont file' }, { status: 400 });
        }
        folders.add('/.fonts');
        folders.add(`/.fonts/${family}`);
        files.set(`/.fonts/${family}/${file.name}`, file);
        return Response.json({ ok: true });
      }
      case 'POST /api/fonts/delete': {
        const { family } = JSON.parse(init!.body as string) as { family: string };
        for (const root of FONT_ROOTS) {
          const folder = `${root}/${family}`;
          for (const p of [...files.keys()]) if (parentOf(p) === folder) files.delete(p);
          folders.delete(folder);
        }
        return Response.json({ ok: true });
      }
      default:
        return new Response('Not found', { status: 404 });
    }
  }) as typeof fetch;

  return { reader: new CrossPointTarget('http://crosspoint.test', fetchFn), files, folders, settings, requests };
}
