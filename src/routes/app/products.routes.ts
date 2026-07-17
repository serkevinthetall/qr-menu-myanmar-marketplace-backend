import { Router } from 'express';

import { authMiddleware } from '../../middleware/auth.js';
import { fetchOdooProducts } from '../../services/odoo.service.js';
import { AuthRequest } from '../../types/auth.js';

const router = Router();

router.use(authMiddleware);

router.get('/', async (req: AuthRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const category = String(req.query.category ?? '').trim();
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 100;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    const fetchLimit = q || category ? Math.min(500, limit + offset + 300) : limit;
    const fetchOffset = q || category ? 0 : offset;

    const products = await fetchOdooProducts(req.user!.id, {
      limit: fetchLimit,
      offset: fetchOffset,
    });

    let data = products.map(product => ({
      id: String(product.id),
      name: product.name,
      sku: product.default_code || '',
      price: product.list_price ?? 0,
      active: product.active,
      category: Array.isArray(product.categ_id) ? product.categ_id[1] : '',
      unit: Array.isArray(product.uom_id) ? product.uom_id[1] : 'Units',
    }));

    if (category) {
      data = data.filter(item => item.category === category);
    }
    if (q) {
      data = data.filter(item => {
        const hay = `${item.name} ${item.sku}`.toLowerCase();
        return hay.includes(q);
      });
    }
    if (q || category) {
      data = data.slice(offset, offset + limit);
    }

    const categories = Array.from(
      new Set(
        products
          .map(product =>
            Array.isArray(product.categ_id) ? product.categ_id[1] : '',
          )
          .filter(Boolean),
      ),
    ).sort((a, b) => a.localeCompare(b));

    return res.json({
      data,
      categories,
      meta: {
        limit,
        offset,
        count: data.length,
        hasMore: q || category ? data.length >= limit : products.length >= limit,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load products.';
    console.error('[app/products]', message);
    return res.status(500).json({ message });
  }
});

export default router;
