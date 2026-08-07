import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import { getOdooSession } from '../services/odoo-session.store.js';
import {
  fetchOdooProductById,
  fetchOdooProductPrices,
  fetchOdooProducts,
  resolveProductFavoriteField,
  updateOdooProductFavorite,
  updateOdooProductPrices,
} from '../services/odoo.service.js';
import {
  listStoredFavoriteProductIds,
  setStoredProductFavorite,
} from '../services/product-favorites.store.js';
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

function mapMembershipPrice(entry: {
  pricelistId: number | null;
  pricelistName: string;
  itemId: number | null;
  price: number | null;
}) {
  return {
    pricelistId: entry.pricelistId != null ? String(entry.pricelistId) : null,
    pricelistName: entry.pricelistName,
    itemId: entry.itemId != null ? String(entry.itemId) : null,
    price: entry.price,
  };
}

async function favoriteForProduct(
  userId: string,
  productId: number,
  odooFavorite: boolean | undefined,
): Promise<boolean> {
  if (typeof odooFavorite === 'boolean') {
    return odooFavorite;
  }
  const stored = await listStoredFavoriteProductIds(userId);
  return stored.has(productId);
}

router.get('/', async (req: AuthRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const filterRaw = String(req.query.filter ?? '').trim();
    const filter = filterRaw === 'qrApp' ? 'qrApp' : undefined;

    const products = await fetchOdooProducts(req.user!.id, {
      limit,
      offset,
      filter,
    });

    const session = getOdooSession(req.user!.id);
    const odooField = session
      ? await resolveProductFavoriteField(session)
      : null;
    const storedFavorites = odooField
      ? null
      : await listStoredFavoriteProductIds(req.user!.id);

    const data = products.map(product => {
      const favorite =
        typeof product.__favorite === 'boolean'
          ? product.__favorite
          : Boolean(storedFavorites?.has(product.id));
      return {
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
        favorite,
      };
    });

    // Favorites first when using ERP store (Odoo field already sorts in search_read).
    if (!odooField) {
      data.sort((a, b) => Number(b.favorite) - Number(a.favorite));
    }

    const effectiveLimit = limit ?? 500;
    return res.json({
      data,
      meta: {
        limit: effectiveLimit,
        offset,
        count: data.length,
        hasMore: data.length >= effectiveLimit,
        filter: filter ?? null,
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

    const favorite = await favoriteForProduct(
      req.user!.id,
      product.id,
      product.__favorite,
    );

    let premium = {
      pricelistId: null as string | null,
      pricelistName: 'Premium Membership',
      itemId: null as string | null,
      price: null as number | null,
    };
    let pro = {
      pricelistId: null as string | null,
      pricelistName: 'Pro Membership',
      itemId: null as string | null,
      price: null as number | null,
    };
    try {
      const prices = await fetchOdooProductPrices(req.user!.id, product.id);
      if (prices) {
        premium = mapMembershipPrice(prices.premium);
        pro = mapMembershipPrice(prices.pro);
      }
    } catch (priceError) {
      console.warn(
        '[products] membership prices unavailable:',
        priceError instanceof Error ? priceError.message : priceError,
      );
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
        favorite,
        premiumPrice: premium,
        proPrice: pro,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load product.';
    console.error('[products]', message);
    return res.status(500).json({ message });
  }
});

router.put('/:id/prices', async (req: AuthRequest, res) => {
  const productId = Number(req.params.id);
  if (!Number.isFinite(productId) || productId <= 0) {
    return res.status(400).json({ message: 'Invalid product id.' });
  }

  const body = req.body ?? {};
  const updates: {
    salesPrice?: number;
    premiumPrice?: number;
    proPrice?: number;
  } = {};

  if (body.salesPrice !== undefined && body.salesPrice !== null && body.salesPrice !== '') {
    updates.salesPrice = Number(body.salesPrice);
  }
  if (
    body.premiumPrice !== undefined &&
    body.premiumPrice !== null &&
    body.premiumPrice !== ''
  ) {
    updates.premiumPrice = Number(body.premiumPrice);
  }
  if (body.proPrice !== undefined && body.proPrice !== null && body.proPrice !== '') {
    updates.proPrice = Number(body.proPrice);
  }

  if (
    updates.salesPrice === undefined &&
    updates.premiumPrice === undefined &&
    updates.proPrice === undefined
  ) {
    return res.status(400).json({ message: 'No prices to update.' });
  }

  try {
    const prices = await updateOdooProductPrices(req.user!.id, productId, updates);
    return res.json({
      data: {
        id: String(productId),
        price: prices.salesPrice,
        premiumPrice: mapMembershipPrice(prices.premium),
        proPrice: mapMembershipPrice(prices.pro),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to update product prices.';
    console.error('[products] prices', message);
    return res.status(500).json({ message });
  }
});

router.put('/:id/favorite', async (req: AuthRequest, res) => {
  const productId = Number(req.params.id);
  if (!Number.isFinite(productId) || productId <= 0) {
    return res.status(400).json({ message: 'Invalid product id.' });
  }

  const favorite = Boolean(req.body?.favorite);
  try {
    const wroteToOdoo = await updateOdooProductFavorite(
      req.user!.id,
      productId,
      favorite,
    );
    if (!wroteToOdoo) {
      await setStoredProductFavorite(req.user!.id, productId, favorite);
    }
    return res.json({
      data: {
        id: String(productId),
        favorite,
        source: wroteToOdoo ? 'odoo' : 'erp',
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to update favorite.';
    console.error('[products] favorite', message);
    return res.status(500).json({ message });
  }
});

export default router;
