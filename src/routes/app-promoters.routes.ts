/**
 * App Promoter master list (Mongo) — feeds the install Request dropdown.
 */
import { Router } from 'express';

import { connectMongo, httpStatusForMongoError, isMongoConfigured } from '../config/mongo.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  AppPromoterModel,
  normalizePromoterName,
  seedDefaultAppPromotersIfEmpty,
} from '../models/app-promoter.model.js';
import { AuthRequest } from '../types/auth.js';

const router = Router();

router.use(authMiddleware);

function requireMongo(res: import('express').Response): boolean {
  if (!isMongoConfigured()) {
    res.status(503).json({
      message:
        'MongoDB is not configured. Set MONGODB_URI on the Vercel backend project.',
    });
    return false;
  }
  return true;
}

function mapPromoter(doc: {
  _id: { toString(): string };
  name?: string | null;
  active?: boolean | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}) {
  return {
    id: doc._id.toString(),
    name: doc.name || '',
    active: doc.active !== false,
    createdAt: doc.createdAt?.toISOString?.() ?? null,
    updatedAt: doc.updatedAt?.toISOString?.() ?? null,
  };
}

/** List promoters. ?active=true returns only active names (for install dropdown). */
router.get('/', async (req: AuthRequest, res) => {
  if (!requireMongo(res)) return;
  try {
    await connectMongo();
    await seedDefaultAppPromotersIfEmpty();

    const activeOnly = String(req.query.active ?? '').trim().toLowerCase();
    const filter =
      activeOnly === 'true' || activeOnly === '1'
        ? { active: true }
        : {};

    const rows = await AppPromoterModel.find(filter)
      .sort({ name: 1 })
      .lean();

    return res.json({
      data: rows.map(row => mapPromoter(row as never)),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load App Promoters.';
    console.error('[app-promoters] list', message);
    return res.status(httpStatusForMongoError(error)).json({ message });
  }
});

router.post('/', async (req: AuthRequest, res) => {
  if (!requireMongo(res)) return;

  const name = normalizePromoterName(req.body?.name);
  if (!name) {
    return res.status(400).json({ message: 'Promoter name is required.' });
  }
  if (name.length > 120) {
    return res.status(400).json({ message: 'Promoter name is too long.' });
  }

  try {
    await connectMongo();
    await seedDefaultAppPromotersIfEmpty();

    const existing = await AppPromoterModel.findOne({ name }).lean();
    if (existing) {
      return res.status(409).json({ message: 'This App Promoter already exists.' });
    }

    const created = await AppPromoterModel.create({ name, active: true });
    return res.status(201).json({ data: mapPromoter(created.toObject() as never) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create App Promoter.';
    console.error('[app-promoters] create', message);
    return res.status(httpStatusForMongoError(error)).json({ message });
  }
});

router.put('/:id', async (req: AuthRequest, res) => {
  if (!requireMongo(res)) return;

  const id = String(req.params.id ?? '').trim();
  if (!id) {
    return res.status(400).json({ message: 'Invalid promoter id.' });
  }

  const hasName = req.body?.name != null;
  const hasActive = req.body?.active != null;
  if (!hasName && !hasActive) {
    return res.status(400).json({ message: 'Nothing to update.' });
  }

  const updates: Record<string, unknown> = {};
  if (hasName) {
    const name = normalizePromoterName(req.body.name);
    if (!name) {
      return res.status(400).json({ message: 'Promoter name is required.' });
    }
    if (name.length > 120) {
      return res.status(400).json({ message: 'Promoter name is too long.' });
    }
    updates.name = name;
  }
  if (hasActive) {
    updates.active = Boolean(req.body.active);
  }

  try {
    await connectMongo();

    if (updates.name) {
      const duplicate = await AppPromoterModel.findOne({
        name: updates.name,
        _id: { $ne: id },
      }).lean();
      if (duplicate) {
        return res.status(409).json({ message: 'This App Promoter already exists.' });
      }
    }

    const doc = await AppPromoterModel.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    }).lean();

    if (!doc) {
      return res.status(404).json({ message: 'App Promoter not found.' });
    }

    return res.json({ data: mapPromoter(doc as never) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to update App Promoter.';
    console.error('[app-promoters] update', message);
    return res.status(httpStatusForMongoError(error)).json({ message });
  }
});

router.delete('/:id', async (req: AuthRequest, res) => {
  if (!requireMongo(res)) return;

  const id = String(req.params.id ?? '').trim();
  if (!id) {
    return res.status(400).json({ message: 'Invalid promoter id.' });
  }

  try {
    await connectMongo();
    const result = await AppPromoterModel.findByIdAndDelete(id).lean();
    if (!result) {
      return res.status(404).json({ message: 'App Promoter not found.' });
    }
    return res.json({
      data: { id, removed: true },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to delete App Promoter.';
    console.error('[app-promoters] delete', message);
    return res.status(httpStatusForMongoError(error)).json({ message });
  }
});

export default router;
