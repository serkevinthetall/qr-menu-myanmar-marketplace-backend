import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type DailyInsightRollup = {
  date: string;
  saleAmount: number;
  saleOrders: number;
  purchaseAmount: number;
  purchaseOrders: number;
  buyingCustomers: number;
  quotations: number;
  itemsSold: number;
  avgOrderValue: number;
  topAreas: { name: string; total: number }[];
  topProducts: { name: string; revenue: number }[];
  bottomProducts: { name: string; revenue: number }[];
  topSpenders: { name: string; total: number; orders: number }[];
};

export type AiSuggestionItem = {
  title: string;
  detail: string;
  priority: 'high' | 'medium' | 'low';
};

export type AiSuggestionPack = {
  generatedAt: string;
  slot: 'monday' | 'friday' | 'monthly' | 'manual';
  model: string;
  suggestions: AiSuggestionItem[];
};

function storeRoot(): string {
  // Prefer durable local folder; fall back to /tmp on read-only serverless FS.
  const primary = path.join(process.cwd(), 'data', 'ai-insights');
  return process.env.AI_INSIGHTS_DATA_DIR?.trim() || primary;
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
    const fallback = path.join('/tmp', 'qr-shop-ai-insights');
    await ensureDir(fallback);
    return fallback;
  }
}

export async function saveDailyRollup(rollup: DailyInsightRollup): Promise<void> {
  const root = await resolveWritableRoot();
  const dir = path.join(root, 'daily');
  await ensureDir(dir);
  const file = path.join(dir, `${rollup.date}.json`);
  await writeFile(file, JSON.stringify(rollup, null, 2), 'utf8');
}

export async function listDailyRollups(limit = 90): Promise<DailyInsightRollup[]> {
  const root = await resolveWritableRoot();
  const dir = path.join(root, 'daily');
  try {
    const names = await readdir(dir);
    const dates = names
      .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .map(name => name.replace(/\.json$/, ''))
      .sort();
    const keep = dates.slice(-Math.max(1, limit));
    const rows: DailyInsightRollup[] = [];
    for (const date of keep) {
      const raw = await readFile(path.join(dir, `${date}.json`), 'utf8');
      rows.push(JSON.parse(raw) as DailyInsightRollup);
    }
    return rows;
  } catch {
    return [];
  }
}

export async function pruneDailyRollups(keepDays = 90): Promise<number> {
  const root = await resolveWritableRoot();
  const dir = path.join(root, 'daily');
  try {
    const names = await readdir(dir);
    const dates = names
      .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .map(name => name.replace(/\.json$/, ''))
      .sort();
    const remove = dates.slice(0, Math.max(0, dates.length - keepDays));
    for (const date of remove) {
      await unlink(path.join(dir, `${date}.json`)).catch(() => undefined);
    }
    return remove.length;
  } catch {
    return 0;
  }
}

export async function saveSuggestionPack(pack: AiSuggestionPack): Promise<void> {
  const root = await resolveWritableRoot();
  await ensureDir(root);
  await writeFile(
    path.join(root, 'latest-suggestions.json'),
    JSON.stringify(pack, null, 2),
    'utf8',
  );
  const historyDir = path.join(root, 'suggestions');
  await ensureDir(historyDir);
  const stamp = pack.generatedAt.replace(/[:.]/g, '-');
  await writeFile(
    path.join(historyDir, `${stamp}-${pack.slot}.json`),
    JSON.stringify(pack, null, 2),
    'utf8',
  );
}

export async function loadLatestSuggestionPack(): Promise<AiSuggestionPack | null> {
  const root = await resolveWritableRoot();
  try {
    const raw = await readFile(path.join(root, 'latest-suggestions.json'), 'utf8');
    return JSON.parse(raw) as AiSuggestionPack;
  } catch {
    return null;
  }
}
