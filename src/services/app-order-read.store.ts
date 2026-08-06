import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

type ReadFile = {
  /** Shared read sale.order ids for the whole team. */
  readOrderIds: number[];
};

function storeRoot(): string {
  const primary = path.join(process.cwd(), 'data', 'app-order-read');
  return process.env.APP_ORDER_READ_DATA_DIR?.trim() || primary;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function resolveWritableRoot(): Promise<string> {
  const primary = storeRoot();
  try {
    await ensureDir(primary);
    const probe = path.join(primary, '.write-probe');
    await writeFile(probe, 'ok', 'utf8');
    await unlink(probe).catch(() => undefined);
    return primary;
  } catch {
    const fallback = path.join('/tmp', 'qr-shop-app-order-read');
    await ensureDir(fallback);
    return fallback;
  }
}

function filePath(root: string): string {
  return path.join(root, 'read.json');
}

async function readAll(): Promise<ReadFile> {
  const root = await resolveWritableRoot();
  try {
    const raw = await readFile(filePath(root), 'utf8');
    const parsed = JSON.parse(raw) as ReadFile;
    if (!parsed || !Array.isArray(parsed.readOrderIds)) {
      return { readOrderIds: [] };
    }
    return {
      readOrderIds: parsed.readOrderIds
        .map(Number)
        .filter(id => Number.isFinite(id) && id > 0),
    };
  } catch {
    return { readOrderIds: [] };
  }
}

async function writeAll(data: ReadFile): Promise<void> {
  const root = await resolveWritableRoot();
  await writeFile(filePath(root), JSON.stringify(data, null, 2), 'utf8');
}

/** Shared across all users/devices. */
export async function listReadAppOrderIds(): Promise<Set<number>> {
  const all = await readAll();
  return new Set(all.readOrderIds);
}

export async function isAppOrderRead(orderId: number): Promise<boolean> {
  if (!Number.isFinite(orderId) || orderId <= 0) return false;
  const ids = await listReadAppOrderIds();
  return ids.has(orderId);
}

export async function setAppOrderRead(
  orderId: number,
  read: boolean,
): Promise<void> {
  if (!Number.isFinite(orderId) || orderId <= 0) return;
  const all = await readAll();
  const set = new Set(all.readOrderIds);
  if (read) {
    set.add(orderId);
  } else {
    set.delete(orderId);
  }
  await writeAll({ readOrderIds: [...set].sort((a, b) => a - b) });
}
