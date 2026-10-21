/**
 * Uploaded files live in IndexedDB (works in the page and the worker), so large photos,
 * audio and GPX files never touch localStorage. Knob values only hold `FileRef`s.
 */
export interface FileRef {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface LoadedFile extends FileRef {
  blob: Blob;
}

const DB = 'aiplo-files';
const STORE = 'files';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function putFile(file: File): Promise<FileRef> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await tx('readwrite', (s) => s.put(file, id));
  return { id, name: file.name, type: file.type, size: file.size };
}

/** Loads the blobs behind file knob values; missing files are skipped. */
export async function loadFiles(refs: FileRef[] | undefined): Promise<LoadedFile[]> {
  if (!Array.isArray(refs)) return [];
  const out: LoadedFile[] = [];
  for (const r of refs) {
    const blob = await tx<Blob | undefined>('readonly', (s) => s.get(r.id) as IDBRequest<Blob | undefined>);
    if (blob) out.push({ ...r, blob });
  }
  return out;
}

export async function loadFile(refs: FileRef[] | undefined): Promise<LoadedFile | null> {
  return (await loadFiles(refs?.slice(0, 1)))[0] ?? null;
}
