import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

type FavoritesFile = Record<string, number[]>;

function storeRoot(): string {
  const primary = path.join(process.cwd(), 'data', 'product-favorites');
  return process.env.PRODUCT_FAVORITES_DATA_DIR?.trim() || primary;
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
    const fallback = path.join('/tmp', 'qr-shop-product-favorites');
    await ensureDir(fallback);
    return fallback;
  }
}

function filePath(root: string): string {
  return path.join(root, 'favorites.json');
}

async function readAll(): Promise<FavoritesFile> {
  const root = await resolveWritableRoot();
  try {
    const raw = await readFile(filePath(root), 'utf8');
    const parsed = JSON.parse(raw) as FavoritesFile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeAll(data: FavoritesFile): Promise<void> {
  const root = await resolveWritableRoot();
  await writeFile(filePath(root), JSON.stringify(data, null, 2), 'utf8');
}

/** Per-user product favorite ids (used when Odoo has no favorite/priority field). */
export async function listStoredFavoriteProductIds(
  userId: string,
): Promise<Set<number>> {
  const all = await readAll();
  const ids = Array.isArray(all[userId]) ? all[userId] : [];
  return new Set(
    ids.filter(id => Number.isFinite(id) && id > 0).map(id => Number(id)),
  );
}

export async function setStoredProductFavorite(
  userId: string,
  productId: number,
  favorite: boolean,
): Promise<void> {
  if (!Number.isFinite(productId) || productId <= 0) return;
  const all = await readAll();
  const current = new Set(
    (Array.isArray(all[userId]) ? all[userId] : []).map(Number),
  );
  if (favorite) {
    current.add(productId);
  } else {
    current.delete(productId);
  }
  all[userId] = [...current].sort((a, b) => a - b);
  await writeAll(all);
}
