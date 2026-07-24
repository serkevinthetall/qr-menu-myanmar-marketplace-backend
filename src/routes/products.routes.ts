import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  fetchOdooProductById,
  fetchOdooProducts,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import {
  toNumberValue,
  toRelationName,
  toStringValue,
} from '../utils/quotation-mapper.js';

const router = Router();

router.use(authMiddleware);

function mapProductImage(image: string | false | undefined): string {
  const raw = toStringValue(image);
  if (!raw) {
    return '';
  }
  if (raw.startsWith('data:') || raw.startsWith('http')) {
    return raw;
  }
  return `data:image/png;base64,${raw}`;
}

router.get('/', async (req: AuthRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    const products = await fetchOdooProducts(req.user!.id, { limit, offset });

    const data = products.map(product => ({
      id: String(product.id),
      name: product.name,
      sku: product.default_code || '',
      price: product.list_price ?? 0,
      stock: product.qty_available ?? 0,
      active: product.active,
      category: Array.isArray(product.categ_id) ? product.categ_id[1] : '',
      // Images omitted on list fetch for speed; UI uses ProductThumb placeholder.
      image: '',
      unit: Array.isArray(product.uom_id) ? product.uom_id[1] : 'Units',
    }));

    const effectiveLimit = limit ?? 500;
    return res.json({
      data,
      meta: {
        limit: effectiveLimit,
        offset,
        count: data.length,
        hasMore: data.length >= effectiveLimit,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load products.';
    return res.status(500).json({ message });
  }
});

router.get('/:id', async (req: AuthRequest, res) => {
  const productId = Number(req.params.id);
  if (!Number.isFinite(productId) || productId <= 0) {
    return res.status(400).json({ message: 'Invalid product id.' });
  }

  try {
    const product = await fetchOdooProductById(req.user!.id, productId);
    if (!product) {
      return res.status(404).json({ message: 'Product not found.' });
    }

    return res.json({
      data: {
        id: String(product.id),
        name: toStringValue(product.name),
        sku: toStringValue(product.default_code),
        price: toNumberValue(product.list_price),
        cost: toNumberValue(product.standard_price),
        stock: toNumberValue(product.qty_available),
        active: Boolean(product.active),
        category: toRelationName(product.categ_id),
        unit: toRelationName(product.uom_id) || 'Units',
        barcode: toStringValue(product.barcode),
        description: toStringValue(product.description_sale),
        type: toStringValue(product.type),
        image: mapProductImage(product.image_128),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load product.';
    console.error('[products]', message);
    return res.status(500).json({ message });
  }
});

export default router;
