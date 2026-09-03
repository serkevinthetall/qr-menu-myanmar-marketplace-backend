import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import { getOdooSession } from '../services/odoo-session.store.js';
import {
  fetchOdooProductAppAccess,
  fetchOdooProductById,
  fetchOdooProductImageBase64,
  fetchOdooProductPrices,
  fetchOdooProductTags,
  fetchOdooProducts,
  resolveProductFavoriteField,
  updateOdooProductAppAccess,
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

function productImagePath(productId: number | string): string {
  return `/products/${productId}/image`;
}

function sniffImageContentType(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/png';
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

function mapAppAccess(app: Awaited<ReturnType<typeof fetchOdooProductAppAccess>>) {
  return {
    saleOk: app.saleOk,
    websitePublished: app.websitePublished,
    hasQrAppTag: app.hasQrAppTag,
    hasEcommerceCategory: app.hasEcommerceCategory,
    readyForApp: app.readyForApp,
    tagIds: app.tagIds.map(String),
    tags: app.tags.map(tag => ({ id: String(tag.id), name: tag.name })),
    ecommerceCategories: app.ecommerceCategories.map(cat => ({
      id: String(cat.id),
      name: cat.name,
    })),
  };
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
        // Authenticated thumbnail proxy — keeps list payloads small.
        image: productImagePath(product.id),
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

router.get('/tags', async (req: AuthRequest, res) => {
  try {
    const tags = await fetchOdooProductTags(req.user!.id);
    return res.json({
      data: tags.map(tag => ({ id: String(tag.id), name: tag.name })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load product tags.';
    console.error('[products] tags', message);
    return res.status(500).json({ message });
  }
});

router.get('/:id/image', async (req: AuthRequest, res) => {
  const productId = Number(req.params.id);
  if (!Number.isFinite(productId) || productId <= 0) {
    return res.status(400).json({ message: 'Invalid product id.' });
  }

  try {
    const base64 = await fetchOdooProductImageBase64(req.user!.id, productId);
    if (!base64) {
      return res.status(404).json({ message: 'Product has no image.' });
    }
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length) {
      return res.status(404).json({ message: 'Product has no image.' });
    }
    res.setHeader('Content-Type', sniffImageContentType(bytes));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.send(bytes);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load product image.';
    console.error('[products] image', message);
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

    let appAccess = null;
    try {
      appAccess = mapAppAccess(
        await fetchOdooProductAppAccess(req.user!.id, product.id),
      );
    } catch (appError) {
      console.warn(
        '[products] app access unavailable:',
        appError instanceof Error ? appError.message : appError,
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
        image: productImagePath(product.id),
        favorite,
        premiumPrice: premium,
        proPrice: pro,
        appAccess,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load product.';
    console.error('[products]', message);
    return res.status(500).json({ message });
  }
});

router.put('/:id/app', async (req: AuthRequest, res) => {
  const productId = Number(req.params.id);
  if (!Number.isFinite(productId) || productId <= 0) {
    return res.status(400).json({ message: 'Invalid product id.' });
  }

  const body = req.body ?? {};
  const enableQrApp =
    typeof body.enableQrApp === 'boolean' ? body.enableQrApp : undefined;
  const websitePublished =
    typeof body.websitePublished === 'boolean'
      ? body.websitePublished
      : undefined;
  const tagIds = Array.isArray(body.tagIds)
    ? body.tagIds
        .map((id: unknown) => Number(id))
        .filter((id: number) => Number.isFinite(id) && id > 0)
    : undefined;

  if (
    enableQrApp === undefined &&
    websitePublished === undefined &&
    tagIds === undefined
  ) {
    return res.status(400).json({ message: 'No app settings to update.' });
  }

  try {
    const app = await updateOdooProductAppAccess(req.user!.id, productId, {
      enableQrApp,
      websitePublished,
      tagIds,
    });
    return res.json({ data: mapAppAccess(app) });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to update product app settings.';
    console.error('[products] app', message);
    let status = 500;
    if (/session expired/i.test(message)) status = 401;
    else if (/not found|invalid product/i.test(message)) status = 404;
    else if (/no app settings/i.test(message)) status = 400;
    return res.status(status).json({ message });
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
