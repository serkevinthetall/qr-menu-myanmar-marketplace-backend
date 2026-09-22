import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  createOdooBom,
  fetchOdooBomById,
  fetchOdooBoms,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import {
  toNumberValue,
  toRelationId,
  toRelationName,
  toStringValue,
} from '../utils/quotation-mapper.js';

const router = Router();

router.use(authMiddleware);

const BOM_TYPE_LABELS: Record<string, string> = {
  normal: 'Manufacture this product',
  phantom: 'Kit',
  subcontract: 'Subcontracting',
};

function mapBomType(type: string): string {
  return BOM_TYPE_LABELS[type] || type || '—';
}

function mapBomSummary(bom: {
  id: number;
  code: string | false;
  product_tmpl_id: [number, string] | false;
  product_id: [number, string] | false;
  product_qty: number;
  uom_id: [number, string] | false;
  type: string;
  company_id: [number, string] | false;
}) {
  return {
    id: String(bom.id),
    reference: toStringValue(bom.code),
    productId: String(toRelationId(bom.product_tmpl_id) || ''),
    product: toRelationName(bom.product_tmpl_id),
    variantId: String(toRelationId(bom.product_id) || ''),
    variant: toRelationName(bom.product_id),
    quantity: toNumberValue(bom.product_qty),
    unit: toRelationName(bom.uom_id) || 'Units',
    type: toStringValue(bom.type),
    typeLabel: mapBomType(toStringValue(bom.type)),
    company: toRelationName(bom.company_id),
  };
}

router.get('/', async (req: AuthRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const q = String(req.query.q ?? '').trim();

    const rows = await fetchOdooBoms(req.user!.id, {
      limit,
      offset,
      q: q || undefined,
    });
    const data = rows.map(mapBomSummary);

    return res.json({
      data,
      meta: {
        limit,
        offset,
        count: data.length,
        hasMore: data.length >= limit,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load bills of materials.';
    console.error('[bills-of-materials]', message);
    return res.status(500).json({ message });
  }
});

router.get('/:id', async (req: AuthRequest, res) => {
  const bomId = Number(req.params.id);
  if (!Number.isFinite(bomId) || bomId <= 0) {
    return res.status(400).json({ message: 'Invalid bill of materials id.' });
  }

  try {
    const bundle = await fetchOdooBomById(req.user!.id, bomId);
    if (!bundle) {
      return res.status(404).json({ message: 'Bill of materials not found.' });
    }

    return res.json({
      data: {
        ...mapBomSummary(bundle.bom),
        lines: bundle.lines.map(line => ({
          id: String(line.id),
          productId: String(toRelationId(line.product_id) || ''),
          product: toRelationName(line.product_id),
          quantity: toNumberValue(line.product_qty),
          unit: toRelationName(line.uom_id) || 'Units',
        })),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load bill of materials.';
    console.error('[bills-of-materials]', message);
    return res.status(500).json({ message });
  }
});

/**
 * Create BoM (Odoo 19.2).
 * Body: { productId, quantity?, code?, type?, lines: [{ productId, quantity }] }
 */
router.post('/', async (req: AuthRequest, res) => {
  const body = req.body ?? {};
  const productId = Number(body.productId);
  if (!Number.isFinite(productId) || productId <= 0) {
    return res.status(400).json({ message: 'A valid product is required.' });
  }

  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (rawLines.length === 0) {
    return res
      .status(400)
      .json({ message: 'Add at least one component before saving.' });
  }

  let parsedLines;
  try {
    parsedLines = rawLines.map((line: Record<string, unknown>, index: number) => {
      const lineProductId = Number(line.productId);
      const quantity = toNumberValue(line.quantity);
      if (!Number.isFinite(lineProductId) || lineProductId <= 0) {
        throw new Error(`Component ${index + 1} is missing a valid product.`);
      }
      if (quantity <= 0) {
        throw new Error(
          `Component ${index + 1} must have a quantity greater than zero.`,
        );
      }
      return { productId: lineProductId, quantity };
    });
  } catch (error) {
    return res.status(400).json({
      message: error instanceof Error ? error.message : 'Invalid components.',
    });
  }

  try {
    const created = await createOdooBom(req.user!.id, {
      productId,
      quantity: toNumberValue(body.quantity) || 1,
      code: toStringValue(body.code) || undefined,
      type: toStringValue(body.type) || 'normal',
      lines: parsedLines,
    });

    const bundle = await fetchOdooBomById(req.user!.id, created.id);
    if (!bundle) {
      return res.status(201).json({
        data: { id: String(created.id) },
      });
    }

    return res.status(201).json({
      data: {
        ...mapBomSummary(bundle.bom),
        lines: bundle.lines.map(line => ({
          id: String(line.id),
          productId: String(toRelationId(line.product_id) || ''),
          product: toRelationName(line.product_id),
          quantity: toNumberValue(line.product_qty),
          unit: toRelationName(line.uom_id) || 'Units',
        })),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to create bill of materials.';
    console.error('[bills-of-materials] create', message);
    return res.status(500).json({ message });
  }
});

export default router;
