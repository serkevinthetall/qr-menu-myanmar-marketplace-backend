import { env } from '../config/env.js';
import {
  lastPhoneDigits,
  normalizeMyanmarPhone,
} from '../utils/myanmar-phone.js';
import {
  deleteOdooSession,
  getOdooSession,
  setOdooSession,
} from './odoo-session.store.js';

type JsonRpcResponse<T> = {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: { message?: string };
  };
};

export type OdooAuthResult = {
  uid: number;
  name: string;
  username: string;
  partner_display_name?: string;
};

export type OdooProduct = {
  id: number;
  name: string;
  default_code: string | false;
  list_price: number;
  qty_available?: number;
  active: boolean;
  categ_id: [number, string] | false;
  image_128?: string | false;
  uom_id: [number, string] | false;
  product_tmpl_id?: [number, string] | false;
  /**
   * Optional favorite field value when present on this Odoo DB
   * (priority on product.template / …).
   */
  __favorite?: boolean;
};

export type OdooProductDetail = OdooProduct & {
  barcode: string | false;
  description_sale: string | false;
  type: string | false;
  standard_price?: number;
};

export type OdooContact = {
  id: number;
  name: string;
  email: string | false;
  phone: string | false;
  city: string | false;
  function: string | false;
  is_company: boolean;
  parent_id: [number, string] | false;
} & Record<string, unknown>;

/** Standard res.partner fields fetched for the Contact module. */
const CONTACT_BASE_FIELDS = [
  'id',
  'name',
  'email',
  'phone',
  'city',
  'function',
  'is_company',
  'parent_id',
];

/** res.partner field linking to the custom Township model. */
export const PARTNER_TOWNSHIP_FIELD = 'x_studio_many2one_field_8u9_1jp4l7r0g';

const TOWNSHIP_FIELDS = [
  'x_name',
  'x_studio_state_link',
  'x_studio_postal_code',
  'x_studio_country_link',
];

type OdooTownship = {
  id: number;
  x_name: string | false;
  x_studio_state_link: [number, string] | false;
  x_studio_postal_code: string | false;
  x_studio_country_link: [number, string] | false;
};

export type ResolvedPartnerLocation = {
  township: string;
  city: string;
  state: string;
  stateId: number | null;
  zip: string;
  country: string;
  countryId: number | null;
};

type PartnerLocationSource = {
  city?: string | false;
  state_id?: [number, string] | false;
  zip?: string | false;
  country_id?: [number, string] | false;
  [PARTNER_TOWNSHIP_FIELD]?: [number, string] | false;
};

/**
 * Custom Odoo Studio fields on res.partner. Technical name -> app key.
 * Add new fields here as they are created in Odoo.
 */
export const CONTACT_CUSTOM_FIELDS = {
  x_studio_monthly_activity: 'activity',
  x_studio_many2one_field_8u9_1jp4l7r0g: 'township',
  x_studio_customer_status: 'status',
  x_studio_last_month_sales: 'lastMonthSales',
  x_studio_this_month_sales: 'thisMonthSales',
  x_studio_this_month_percent: 'thisMonthPercent',
  x_studio_last_invoice_date: 'lastInvoiceDate',
  x_studio_expo_push_token: 'expoPushToken',
} as const;

/** Fields fetched for the contact detail view. */
const CONTACT_DETAIL_FIELDS = [
  'name',
  'parent_id',
  'email',
  'phone',
  'street',
  'street2',
  'city',
  'state_id',
  'zip',
  'country_id',
  'category_id',
  'x_studio_member_code',
  PARTNER_TOWNSHIP_FIELD,
];

type OdooContactDetail = {
  id: number;
  name: string;
  parent_id: [number, string] | false;
  email: string | false;
  phone: string | false;
  street: string | false;
  street2: string | false;
  city: string | false;
  state_id: [number, string] | false;
  zip: string | false;
  country_id: [number, string] | false;
  category_id: number[] | false;
  x_studio_member_code: string | false;
  x_studio_many2one_field_8u9_1jp4l7r0g: [number, string] | false;
};

/** Extra ad-hoc fields configured via env, appended as raw strings. */
const CONTACT_EXTRA_FIELDS = env.odooContactExtraFields;

function extractSessionCookie(setCookieHeaders: string[]): string {
  for (const header of setCookieHeaders) {
    const match = header.match(/session_id=([^;]+)/);
    if (match?.[1]) {
      return `session_id=${match[1]}`;
    }
  }
  return '';
}

export async function authenticateWithOdoo(login: string, password: string) {
  let response: Response;
  try {
    response = await fetch(`${env.odooUrl}/web/session/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          db: env.odooDb,
          login: login.trim(),
          password,
        },
        id: Date.now(),
      }),
    });
  } catch {
    throw new Error(
      'Could not reach Odoo. Check ODOO_URL on the server and try again.',
    );
  }

  if (!response.ok) {
    throw new Error(
      `Odoo authentication failed (HTTP ${response.status}). Check ODOO_URL / ODOO_DB.`,
    );
  }

  const setCookie =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];

  const data = (await response.json()) as JsonRpcResponse<OdooAuthResult>;

  if (data.error) {
    throw new Error('Invalid email or password.');
  }

  const result = data.result;

  if (!result?.uid) {
    throw new Error('Invalid email or password.');
  }

  const cookie = extractSessionCookie(setCookie);

  if (!cookie) {
    throw new Error('Could not establish Odoo session.');
  }

  const userId = String(result.uid);

  setOdooSession(userId, {
    cookie,
    uid: result.uid,
    login,
    createdAt: Date.now(),
  });

  return {
    uid: result.uid,
    name: result.name || result.partner_display_name || login,
    email: result.username || login,
    cookie,
  };
}

export async function destroyOdooSession(
  userId: string,
  sessionOverride?: { cookie: string },
) {
  const session = sessionOverride ?? getOdooSession(userId);

  if (session) {
    try {
      await fetch(`${env.odooUrl}/web/session/destroy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: session.cookie,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          params: {},
          id: Date.now(),
        }),
      });
    } catch {
      // Ignore destroy errors — local session will still be cleared.
    }
  }

  deleteOdooSession(userId);
}

export async function fetchOdooProducts(
  userId: string,
  options?: {
    limit?: number;
    offset?: number;
    /** Case-insensitive match on product name or internal reference (SKU). */
    q?: string;
    /** Exact match on product category display name. */
    category?: string;
    /**
     * QR App catalog: Sales ticked, Published on, Tags contain "QR App".
     * product.template fields via product.product relations.
     */
    filter?: 'qrApp';
  },
): Promise<OdooProduct[]> {
  const session = getOdooSession(userId);

  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const limit =
    options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
      ? Math.min(Math.floor(options.limit), 500)
      : 500;
  const offset =
    options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
      ? Math.floor(options.offset)
      : 0;

  const q = String(options?.q ?? '').trim();
  const category = String(options?.category ?? '').trim();

  const domain: unknown[] = [['active', '=', true]];
  if (options?.filter === 'qrApp') {
    // sale_ok / website_published / product_tag_ids live on product.template;
    // use template paths so product.product search_read stays reliable.
    domain.push(['sale_ok', '=', true]);
    domain.push(['product_tmpl_id.website_published', '=', true]);
    domain.push(['product_tmpl_id.product_tag_ids.name', 'ilike', 'QR App']);
  }
  if (q) {
    domain.push('|');
    domain.push(['name', 'ilike', q]);
    domain.push(['default_code', 'ilike', q]);
  }
  if (category) {
    domain.push(['categ_id.name', '=', category]);
  }

  const fields = [
    'id',
    'name',
    'default_code',
    'list_price',
    'active',
    'categ_id',
    'uom_id',
    'product_tmpl_id',
  ];

  // Odoo Product Kanban stars use product.template.priority.
  const favoriteField = await resolveProductFavoriteField(session);
  if (favoriteField?.model === 'product.product') {
    fields.push(favoriteField.name);
  }

  const callSearchRead = async (searchDomain: unknown[]) => {
    const response = await fetch(`${env.odooUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: session.cookie,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'product.product',
          method: 'search_read',
          args: [searchDomain, fields],
          kwargs: {
            order:
              favoriteField?.model === 'product.product'
                ? `${favoriteField.name} desc, name asc`
                : favoriteField?.model === 'product.template'
                  ? `product_tmpl_id.${favoriteField.name} desc, name asc`
                  : 'name asc',
            // Avoid image_128 (huge payload) and qty_available (slow computed field).
            limit,
            offset,
          },
        },
        id: Date.now(),
      }),
    });

    return (await response.json()) as JsonRpcResponse<OdooProduct[]>;
  };

  let data = await callSearchRead(domain);

  // Fallback when website_published / tags are directly on product.product.
  if (data.error && options?.filter === 'qrApp') {
    const fallbackDomain: unknown[] = [
      ['active', '=', true],
      ['sale_ok', '=', true],
      ['website_published', '=', true],
      ['product_tag_ids.name', 'ilike', 'QR App'],
    ];
    if (q) {
      fallbackDomain.push('|');
      fallbackDomain.push(['name', 'ilike', q]);
      fallbackDomain.push(['default_code', 'ilike', q]);
    }
    if (category) {
      fallbackDomain.push(['categ_id.name', '=', category]);
    }
    data = await callSearchRead(fallbackDomain);
  }

  // If related order path fails on older Odoo, retry with plain name order.
  if (data.error && favoriteField?.model === 'product.template') {
    const retry = await fetch(`${env.odooUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: session.cookie,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          model: 'product.product',
          method: 'search_read',
          args: [domain, fields],
          kwargs: { order: 'name asc', limit, offset },
        },
        id: Date.now(),
      }),
    });
    data = (await retry.json()) as JsonRpcResponse<OdooProduct[]>;
  }

  if (data.error) {
    const message =
      data.error.data?.message ?? data.error.message ?? 'Failed to load products.';
    throw new Error(message);
  }

  return attachProductFavorites(session, data.result ?? [], favoriteField);
}

const PRODUCT_DETAIL_FIELDS = [
  'id',
  'name',
  'default_code',
  'list_price',
  'qty_available',
  'active',
  'categ_id',
  'uom_id',
  'barcode',
  'description_sale',
  'type',
  'standard_price',
];

const PRODUCT_DETAIL_FIELDS_MIN = [
  'id',
  'name',
  'default_code',
  'list_price',
  'active',
  'categ_id',
  'uom_id',
];

export async function fetchOdooProductById(
  userId: string,
  productId: number,
): Promise<OdooProductDetail | null> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const favoriteField = await resolveProductFavoriteField(session);
  const extraFields = ['product_tmpl_id'];
  if (favoriteField?.model === 'product.product') {
    extraFields.push(favoriteField.name);
  }
  const detailFields = [...PRODUCT_DETAIL_FIELDS, ...extraFields];
  const minFields = [...PRODUCT_DETAIL_FIELDS_MIN, ...extraFields];

  try {
    const detail = await readOdooRecordAsUser<OdooProductDetail>(
      session,
      'product.product',
      productId,
      detailFields,
    );
    if (detail) {
      const [withFav] = await attachProductFavorites(session, [detail], favoriteField);
      return withFav as OdooProductDetail;
    }
  } catch (error) {
    console.warn(
      '[products] Detail fields failed, falling back to minimal fields:',
      error instanceof Error ? error.message : error,
    );
  }

  try {
    const detail = await readOdooRecordAsUser<OdooProductDetail>(
      session,
      'product.product',
      productId,
      minFields,
    );
    if (!detail) return null;
    const [withFav] = await attachProductFavorites(session, [detail], favoriteField);
    return withFav as OdooProductDetail;
  } catch (error) {
    console.error(
      '[products] Failed to read product:',
      error instanceof Error ? error.message : error,
    );
    throw error instanceof Error
      ? error
      : new Error('Failed to load product.');
  }
}

/**
 * Toggle product favorite.
 * Uses Odoo product.template.priority (Kanban star) when available;
 * otherwise returns false so the caller can persist in the ERP store.
 */
export async function updateOdooProductFavorite(
  userId: string,
  productId: number,
  favorite: boolean,
): Promise<boolean> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const favoriteField = await resolveProductFavoriteField(session);
  if (!favoriteField) {
    return false;
  }

  const value = odooValueFromFavorite(favorite, favoriteField.kind);

  if (favoriteField.model === 'product.product') {
    await writeOdooRecordAsUser(session, 'product.product', productId, {
      [favoriteField.name]: value,
    });
    return true;
  }

  const product = await readOdooRecordAsUser<{
    product_tmpl_id?: [number, string] | false;
  }>(session, 'product.product', productId, ['product_tmpl_id']);
  const tmplId = templateIdFromProduct(product ?? {});
  if (!tmplId) {
    throw new Error('Could not resolve product template for favorite.');
  }

  await writeOdooRecordAsUser(session, 'product.template', tmplId, {
    [favoriteField.name]: value,
  });
  return true;
}

export type OdooProductMembershipPrice = {
  pricelistId: number | null;
  pricelistName: string;
  itemId: number | null;
  price: number | null;
};

export type OdooProductPrices = {
  salesPrice: number;
  premium: OdooProductMembershipPrice;
  pro: OdooProductMembershipPrice;
};

type OdooPricelistRow = { id: number; name: string };
type OdooPricelistItemRow = {
  id: number;
  pricelist_id: [number, string] | false;
  product_tmpl_id: [number, string] | false;
  product_id: [number, string] | false;
  min_quantity: number;
  compute_price?: string;
  fixed_price?: number;
  price?: number;
};

const pricelistIdCache = new Map<string, number | null>();

function relationId(value: [number, string] | false | undefined): number | null {
  return Array.isArray(value) && typeof value[0] === 'number' ? value[0] : null;
}

function itemFixedPrice(row: OdooPricelistItemRow): number | null {
  const fixed = Number(row.fixed_price);
  if (Number.isFinite(fixed)) {
    return fixed;
  }
  const legacy = Number(row.price);
  return Number.isFinite(legacy) ? legacy : null;
}

async function findPricelistIdByName(
  session: { cookie: string; uid: number },
  nameQuery: string,
): Promise<number | null> {
  const key = nameQuery.trim().toLowerCase();
  if (!key) return null;
  if (pricelistIdCache.has(key)) {
    return pricelistIdCache.get(key) ?? null;
  }

  const rows = await searchReadOdooRecords<OdooPricelistRow>(
    session,
    'product.pricelist',
    [['name', 'ilike', nameQuery], ['active', '=', true]],
    ['id', 'name'],
    { limit: 5, order: 'id asc' },
  );

  // Prefer an exact (case-insensitive) match, else first ilike hit.
  const exact = rows.find(row => row.name.trim().toLowerCase() === key);
  const chosen = exact ?? rows[0] ?? null;
  const id = chosen?.id ?? null;
  pricelistIdCache.set(key, id);
  return id;
}

async function findPricelistItemForProduct(
  session: { cookie: string; uid: number },
  pricelistId: number,
  productId: number,
  templateId: number,
): Promise<OdooPricelistItemRow | null> {
  const rows = await searchReadOdooRecords<OdooPricelistItemRow>(
    session,
    'product.pricelist.item',
    [
      '&',
      ['pricelist_id', '=', pricelistId],
      '|',
      ['product_id', '=', productId],
      ['product_tmpl_id', '=', templateId],
    ],
    [
      'id',
      'pricelist_id',
      'product_tmpl_id',
      'product_id',
      'min_quantity',
      'compute_price',
      'fixed_price',
      'price',
    ],
    { limit: 20, order: 'min_quantity asc, id asc' },
  );

  if (!rows.length) return null;

  const variantExact = rows.find(row => relationId(row.product_id) === productId);
  if (variantExact) return variantExact;

  const templateExact = rows.find(
    row =>
      relationId(row.product_tmpl_id) === templateId && !relationId(row.product_id),
  );
  return templateExact ?? rows[0] ?? null;
}

async function loadMembershipPrice(
  session: { cookie: string; uid: number },
  pricelistName: string,
  productId: number,
  templateId: number,
): Promise<OdooProductMembershipPrice> {
  const pricelistId = await findPricelistIdByName(session, pricelistName);
  if (!pricelistId) {
    return {
      pricelistId: null,
      pricelistName,
      itemId: null,
      price: null,
    };
  }

  const item = await findPricelistItemForProduct(
    session,
    pricelistId,
    productId,
    templateId,
  );

  return {
    pricelistId,
    pricelistName,
    itemId: item?.id ?? null,
    price: item ? itemFixedPrice(item) : null,
  };
}

/**
 * Sales list_price + Premium / Pro membership pricelist fixed prices.
 */
export async function fetchOdooProductPrices(
  userId: string,
  productId: number,
): Promise<OdooProductPrices | null> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const product = await readOdooRecordAsUser<{
    list_price?: number;
    product_tmpl_id?: [number, string] | false;
  }>(session, 'product.product', productId, ['list_price', 'product_tmpl_id']);
  if (!product) return null;

  const templateId = templateIdFromProduct(product);
  if (!templateId) {
    throw new Error('Could not resolve product template for prices.');
  }

  const [premium, pro] = await Promise.all([
    loadMembershipPrice(
      session,
      env.odooPricelistPremiumName,
      productId,
      templateId,
    ),
    loadMembershipPrice(
      session,
      env.odooPricelistProName,
      productId,
      templateId,
    ),
  ]);

  return {
    salesPrice: Number(product.list_price) || 0,
    premium,
    pro,
  };
}

async function upsertMembershipFixedPrice(
  session: { cookie: string; uid: number },
  pricelistName: string,
  productId: number,
  templateId: number,
  price: number,
): Promise<OdooProductMembershipPrice> {
  const pricelistId = await findPricelistIdByName(session, pricelistName);
  if (!pricelistId) {
    throw new Error(
      `Pricelist "${pricelistName}" was not found in Odoo. Check the name or set ODOO_PRICELIST_* env vars.`,
    );
  }

  const existing = await findPricelistItemForProduct(
    session,
    pricelistId,
    productId,
    templateId,
  );

  if (existing) {
    try {
      await writeOdooRecordAsUser(session, 'product.pricelist.item', existing.id, {
        compute_price: 'fixed',
        fixed_price: price,
        min_quantity: existing.min_quantity > 0 ? existing.min_quantity : 1,
      });
    } catch {
      // Older DBs may use `price` instead of `fixed_price`.
      await writeOdooRecordAsUser(session, 'product.pricelist.item', existing.id, {
        compute_price: 'fixed',
        price,
        min_quantity: existing.min_quantity > 0 ? existing.min_quantity : 1,
      });
    }
    return {
      pricelistId,
      pricelistName,
      itemId: existing.id,
      price,
    };
  }

  let itemId: number;
  try {
    itemId = await createOdooRecordAsUser(session, 'product.pricelist.item', {
      pricelist_id: pricelistId,
      applied_on: '1_product',
      product_tmpl_id: templateId,
      compute_price: 'fixed',
      fixed_price: price,
      min_quantity: 1,
    });
  } catch {
    itemId = await createOdooRecordAsUser(session, 'product.pricelist.item', {
      pricelist_id: pricelistId,
      applied_on: '1_product',
      product_tmpl_id: templateId,
      compute_price: 'fixed',
      price,
      min_quantity: 1,
    });
  }

  return {
    pricelistId,
    pricelistName,
    itemId,
    price,
  };
}

export async function updateOdooProductPrices(
  userId: string,
  productId: number,
  updates: {
    salesPrice?: number;
    premiumPrice?: number;
    proPrice?: number;
  },
): Promise<OdooProductPrices> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const product = await readOdooRecordAsUser<{
    list_price?: number;
    product_tmpl_id?: [number, string] | false;
  }>(session, 'product.product', productId, ['list_price', 'product_tmpl_id']);
  if (!product) {
    throw new Error('Product not found.');
  }

  const templateId = templateIdFromProduct(product);
  if (!templateId) {
    throw new Error('Could not resolve product template for prices.');
  }

  if (updates.salesPrice !== undefined) {
    if (!Number.isFinite(updates.salesPrice) || updates.salesPrice < 0) {
      throw new Error('Invalid sales price.');
    }
    await writeOdooRecordAsUser(session, 'product.template', templateId, {
      list_price: updates.salesPrice,
    });
  }

  if (updates.premiumPrice !== undefined) {
    if (!Number.isFinite(updates.premiumPrice) || updates.premiumPrice < 0) {
      throw new Error('Invalid Premium Membership price.');
    }
    await upsertMembershipFixedPrice(
      session,
      env.odooPricelistPremiumName,
      productId,
      templateId,
      updates.premiumPrice,
    );
  }

  if (updates.proPrice !== undefined) {
    if (!Number.isFinite(updates.proPrice) || updates.proPrice < 0) {
      throw new Error('Invalid Pro Membership price.');
    }
    await upsertMembershipFixedPrice(
      session,
      env.odooPricelistProName,
      productId,
      templateId,
      updates.proPrice,
    );
  }

  const prices = await fetchOdooProductPrices(userId, productId);
  if (!prices) {
    throw new Error('Failed to reload product prices.');
  }
  return prices;
}

export type OdooQuotation = {
  id: number;
  name: string;
  create_date: string | false;
  partner_id: [number, string] | false;
  amount_total: number;
  state: string;
  preferred_payment_method_line_id?: [number, string] | false;
  x_studio_phonenumber?: string | false;
  x_studio_phonenumber_1?: string | false;
  x_studio_sale_person_name?: string | false;
};

export type OdooQuotationDetail = OdooQuotation & {
  partner_shipping_id: [number, string] | false;
  partner_invoice_id: [number, string] | false;
  validity_date: string | false;
  date_order: string | false;
  amount_untaxed: number;
  user_id: [number, string] | false;
  pricelist_id: [number, string] | false;
  payment_term_id: [number, string] | false;
  preferred_payment_method_line_id: [number, string] | false;
  x_studio_membership_coupon_ticket: string | false;
  x_studio_membership_coupon_status: string | false;
  x_studio_phonenumber: string | false;
  x_studio_phonenumber_1: string | false;
  x_studio_preferred_delivery_date: string | false;
  x_studio_delivery_notes: string | false;
  x_studio_sale_person_name: string | false;
  commitment_date: string | false;
};

export type OdooPartnerAddress = {
  street: string | false;
  street2: string | false;
  city: string | false;
  zip: string | false;
  phone: string | false;
  state_id: [number, string] | false;
  country_id: [number, string] | false;
  x_studio_many2one_field_8u9_1jp4l7r0g: [number, string] | false;
};

const PARTNER_ADDRESS_FIELDS = [
  'street',
  'street2',
  'city',
  'zip',
  'phone',
  'state_id',
  'country_id',
  PARTNER_TOWNSHIP_FIELD,
];

export type OdooOrderLine = {
  id: number;
  name: string;
  product_id: [number, string] | false;
  product_uom_qty: number;
  product_uom_id: [number, string] | false;
  price_unit: number;
  discount: number;
  price_subtotal: number;
};

const QUOTATION_LIST_FIELDS = [
  'id',
  'name',
  'create_date',
  'partner_id',
  'amount_total',
  'state',
  'preferred_payment_method_line_id',
  'x_studio_phonenumber_1',
  'x_studio_phonenumber',
  'x_studio_sale_person_name',
];

const QUOTATION_DETAIL_FIELDS = [
  ...QUOTATION_LIST_FIELDS,
  'partner_shipping_id',
  'partner_invoice_id',
  'validity_date',
  'date_order',
  'amount_untaxed',
  'user_id',
  'pricelist_id',
  'payment_term_id',
  'preferred_payment_method_line_id',
  'x_studio_membership_coupon_ticket',
  'x_studio_membership_coupon_status',
  'x_studio_preferred_delivery_date',
  'x_studio_delivery_notes',
  'commitment_date',
];

const ORDER_LINE_FIELDS = [
  'id',
  'name',
  'product_id',
  'product_uom_qty',
  'product_uom_id',
  'price_unit',
  'discount',
  'price_subtotal',
];

async function odooCallKw<T>(
  cookie: string,
  model: string,
  method: string,
  args: unknown[] = [],
  kwargs: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(`${env.odooUrl}/web/dataset/call_kw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { model, method, args, kwargs },
      id: Date.now(),
    }),
  });

  const data = (await response.json()) as JsonRpcResponse<T>;

  if (data.error) {
    const message =
      data.error.data?.message ?? data.error.message ?? 'Odoo request failed.';
    throw new Error(message);
  }

  return data.result as T;
}

async function odooExecuteKw<T>(
  uid: number,
  model: string,
  method: string,
  args: unknown[] = [],
  kwargs: Record<string, unknown> = {},
): Promise<T> {
  if (!env.odooApiKey) {
    throw new Error('ODOO_API_KEY is not configured.');
  }

  const response = await fetch(`${env.odooUrl}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service: 'object',
        method: 'execute_kw',
        args: [env.odooDb, uid, env.odooApiKey, model, method, args, kwargs],
      },
      id: Date.now(),
    }),
  });

  const data = (await response.json()) as JsonRpcResponse<T>;

  if (data.error) {
    const message =
      data.error.data?.message ?? data.error.message ?? 'Odoo request failed.';
    throw new Error(message);
  }

  return data.result as T;
}

async function readOdooRecordAsUser<T>(
  session: { cookie: string; uid: number },
  model: string,
  recordId: number,
  fields: string[],
): Promise<T | null> {
  const rows = await odooCallKw<T[]>(session.cookie, model, 'read', [
    [recordId],
    fields,
  ]);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/** Tiny product image fetch for the /products/:id/image proxy. */
export async function fetchOdooProductImageBase64(
  userId: string,
  productId: number,
): Promise<string | null> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const row = await readOdooRecordAsUser<{
    image_128?: string | false;
    product_tmpl_id?: [number, string] | false;
  }>(session, 'product.product', productId, ['image_128', 'product_tmpl_id']);

  const onVariant = row?.image_128;
  if (typeof onVariant === 'string' && onVariant.trim()) {
    return onVariant.trim();
  }

  // Many Odoo setups keep the photo on product.template only.
  const templateId = Array.isArray(row?.product_tmpl_id)
    ? Number(row.product_tmpl_id[0])
    : 0;
  if (Number.isFinite(templateId) && templateId > 0) {
    const template = await readOdooRecordAsUser<{ image_128?: string | false }>(
      session,
      'product.template',
      templateId,
      ['image_128'],
    );
    const onTemplate = template?.image_128;
    if (typeof onTemplate === 'string' && onTemplate.trim()) {
      return onTemplate.trim();
    }
  }

  return null;
}

async function createOdooRecordAsUser(
  session: { cookie: string; uid: number },
  model: string,
  values: Record<string, unknown>,
): Promise<number> {
  return odooCallKw<number>(session.cookie, model, 'create', [values]);
}

async function writeOdooRecordAsUser(
  session: { cookie: string; uid: number },
  model: string,
  recordId: number,
  values: Record<string, unknown>,
): Promise<void> {
  await odooCallKw(session.cookie, model, 'write', [[recordId], values]);
}

type ProductFavoriteField = {
  name: string;
  kind: 'boolean' | 'selection';
  /** Odoo product stars live on product.template (priority), not product.product. */
  model: 'product.product' | 'product.template';
};

const PRODUCT_FAVORITE_FIELD_CANDIDATES = [
  'priority',
  'x_studio_favorite',
  'x_studio_priority',
  'x_favorite',
] as const;

let cachedProductFavoriteField: ProductFavoriteField | null | undefined;

function isFavoriteOdooValue(
  value: unknown,
  kind: ProductFavoriteField['kind'],
): boolean {
  if (kind === 'boolean') {
    return Boolean(value);
  }
  return String(value ?? '0') === '1' || String(value ?? '') === 'true';
}

function odooValueFromFavorite(
  favorite: boolean,
  kind: ProductFavoriteField['kind'],
): boolean | string {
  return kind === 'boolean' ? favorite : favorite ? '1' : '0';
}

function templateIdFromProduct(row: {
  product_tmpl_id?: [number, string] | false | number;
}): number | null {
  const raw = row.product_tmpl_id;
  if (Array.isArray(raw) && typeof raw[0] === 'number') {
    return raw[0];
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return null;
}

async function pickFavoriteFieldOnModel(
  session: { cookie: string; uid: number },
  model: 'product.product' | 'product.template',
): Promise<Omit<ProductFavoriteField, 'model'> | null> {
  try {
    const fields = await odooCallKw<
      Record<string, { type?: string; store?: boolean; readonly?: boolean }>
    >(session.cookie, model, 'fields_get', [
      [...PRODUCT_FAVORITE_FIELD_CANDIDATES],
      ['type', 'store', 'readonly'],
    ]);

    for (const name of PRODUCT_FAVORITE_FIELD_CANDIDATES) {
      const meta = fields?.[name];
      if (!meta) continue;
      if (meta.readonly) continue;
      if (meta.store === false) continue;
      if (meta.type === 'boolean') {
        return { name, kind: 'boolean' };
      }
      if (meta.type === 'selection') {
        return { name, kind: 'selection' };
      }
    }
  } catch (error) {
    console.warn(
      `[products] Could not resolve favorite field on ${model}:`,
      error instanceof Error ? error.message : error,
    );
  }
  return null;
}

/**
 * Detect Odoo product favorite/star field.
 * Odoo Product Kanban stars use product.template.priority ('1' = favorite).
 */
export async function resolveProductFavoriteField(
  session: { cookie: string; uid: number },
): Promise<ProductFavoriteField | null> {
  if (cachedProductFavoriteField !== undefined) {
    return cachedProductFavoriteField;
  }

  const onProduct = await pickFavoriteFieldOnModel(session, 'product.product');
  if (onProduct) {
    cachedProductFavoriteField = { ...onProduct, model: 'product.product' };
    return cachedProductFavoriteField;
  }

  const onTemplate = await pickFavoriteFieldOnModel(session, 'product.template');
  if (onTemplate) {
    cachedProductFavoriteField = { ...onTemplate, model: 'product.template' };
    return cachedProductFavoriteField;
  }

  cachedProductFavoriteField = null;
  return null;
}

async function attachProductFavorites(
  session: { cookie: string; uid: number },
  rows: OdooProduct[],
  favoriteField: ProductFavoriteField | null,
): Promise<OdooProduct[]> {
  if (!favoriteField || rows.length === 0) {
    return rows;
  }

  if (favoriteField.model === 'product.product') {
    return rows.map(row => {
      const raw = (row as Record<string, unknown>)[favoriteField.name];
      return {
        ...row,
        __favorite: isFavoriteOdooValue(raw, favoriteField.kind),
      };
    });
  }

  const tmplIds = [
    ...new Set(
      rows
        .map(row =>
          templateIdFromProduct(row as { product_tmpl_id?: [number, string] | false }),
        )
        .filter((id): id is number => id !== null),
    ),
  ];
  if (tmplIds.length === 0) {
    return rows.map(row => ({ ...row, __favorite: false }));
  }

  const templates = await odooCallKw<
    { id: number; [key: string]: unknown }[]
  >(session.cookie, 'product.template', 'search_read', [
    [['id', 'in', tmplIds]],
    ['id', favoriteField.name],
  ], { limit: tmplIds.length });

  const favoriteByTmpl = new Map<number, boolean>();
  for (const tmpl of templates ?? []) {
    favoriteByTmpl.set(
      tmpl.id,
      isFavoriteOdooValue(tmpl[favoriteField.name], favoriteField.kind),
    );
  }

  return rows.map(row => {
    const tmplId = templateIdFromProduct(
      row as { product_tmpl_id?: [number, string] | false },
    );
    return {
      ...row,
      __favorite: tmplId ? Boolean(favoriteByTmpl.get(tmplId)) : false,
    };
  });
}

/**
 * Resolve the live Studio field name for Sale Person Name.
 * Prefer the known technical name; fall back to ir.model.fields lookup.
 */
async function resolveSalePersonFieldName(
  session: { cookie: string; uid: number },
): Promise<string> {
  const known = 'x_studio_sale_person_name';

  try {
    const fields = await odooCallKw<
      Record<string, { type?: string; string?: string; store?: boolean; readonly?: boolean }>
    >(session.cookie, 'sale.order', 'fields_get', [
      [known],
      ['type', 'string', 'store', 'readonly'],
    ]);
    const meta = fields?.[known];
    if (meta) {
      if (meta.readonly) {
        throw new Error(
          `Sale Person Name field "${known}" is read-only in Odoo. Uncheck Readonly in Studio.`,
        );
      }
      if (meta.store === false) {
        throw new Error(
          `Sale Person Name field "${known}" is not stored. In Studio, enable Stored so API can save it.`,
        );
      }
      return known;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Sale Person Name field')) {
      throw error;
    }
    // fields_get may fail for missing fields; try ir.model.fields next.
  }

  try {
    const rows = await odooCallKw<
      { name: string; field_description: string | false; store: boolean }[]
    >(
      session.cookie,
      'ir.model.fields',
      'search_read',
      [
        [
          ['model', '=', 'sale.order'],
          '|',
          ['name', '=', known],
          '&',
          ['name', 'ilike', 'sale_person'],
          ['ttype', '=', 'char'],
        ],
        ['name', 'field_description', 'store'],
      ],
      { limit: 10 },
    );

    const exact = rows?.find(row => row.name === known);
    if (exact) {
      if (exact.store === false) {
        throw new Error(
          `Sale Person Name field "${known}" is not stored. In Studio, enable Stored so API can save it.`,
        );
      }
      return exact.name;
    }

    const byLabel = rows?.find(row =>
      String(row.field_description || '')
        .toLowerCase()
        .includes('sale person'),
    );
    if (byLabel) {
      return byLabel.name;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Sale Person Name field')) {
      throw error;
    }
    // Fall through to the known Studio name.
  }

  return known;
}

async function readOdooRecord<T>(
  session: { cookie: string; uid: number },
  model: string,
  recordId: number,
  fields: string[],
): Promise<T | null> {
  if (env.odooApiKey) {
    try {
      const rows = await odooExecuteKw<T[]>(
        session.uid,
        model,
        'read',
        [[recordId], fields],
      );

      if (Array.isArray(rows) && rows[0]) {
        return rows[0];
      }
    } catch {
      // API key read can fail; fall back to the login session.
    }
  }

  const rows = await odooCallKw<T[]>(session.cookie, model, 'read', [[recordId], fields]);

  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function createOdooRecord(
  session: { cookie: string; uid: number },
  model: string,
  values: Record<string, unknown>,
): Promise<number> {
  if (env.odooApiKey) {
    try {
      return await odooExecuteKw<number>(session.uid, model, 'create', [values]);
    } catch {
      // API key create can fail with Access Denied; use the login session instead.
    }
  }

  return odooCallKw<number>(session.cookie, model, 'create', [values]);
}

/** Prefer the login cookie so Studio fields respect the user’s field access. */
async function writeOdooRecord(
  session: { cookie: string; uid: number },
  model: string,
  recordId: number,
  values: Record<string, unknown>,
): Promise<void> {
  await odooCallKw(session.cookie, model, 'write', [[recordId], values]);
}

export type CreateQuotationLineInput = {
  productId: number;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
};

export type CreateQuotationInput = {
  partnerId: number;
  shippingPartnerId?: number;
  salePersonName?: string;
  deliveryNotes?: string;
  preferredDeliveryDate?: string;
  phoneNumber?: string;
  paymentMethodLineId?: number;
  lines: CreateQuotationLineInput[];
};

export async function createOdooQuotation(
  userId: string,
  input: CreateQuotationInput,
  sessionOverride?: { cookie: string; uid: number },
): Promise<{ id: number; name: string }> {
  const session = sessionOverride ?? getOdooSession(userId);

  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  if (!Number.isFinite(input.partnerId) || input.partnerId <= 0) {
    throw new Error('A valid customer is required.');
  }

  if (input.lines.length === 0) {
    throw new Error('Add at least one product before saving.');
  }

  const orderLineCommands = input.lines.map(line => [
    0,
    0,
    {
      product_id: line.productId,
      product_uom_qty: line.quantity,
      price_unit: line.unitPrice,
      discount: line.discountPercent,
    },
  ]);

  const shippingPartnerId =
    input.shippingPartnerId !== undefined &&
    Number.isFinite(input.shippingPartnerId) &&
    input.shippingPartnerId > 0
      ? input.shippingPartnerId
      : input.partnerId;

  const values: Record<string, unknown> = {
    partner_id: input.partnerId,
    partner_invoice_id: input.partnerId,
    partner_shipping_id: shippingPartnerId,
    order_line: orderLineCommands,
  };

  if (
    input.paymentMethodLineId !== undefined &&
    Number.isFinite(input.paymentMethodLineId) &&
    input.paymentMethodLineId > 0
  ) {
    values.preferred_payment_method_line_id = input.paymentMethodLineId;
  }

  const studioValues: Record<string, unknown> = {};

  const deliveryNotes = input.deliveryNotes?.trim();
  if (deliveryNotes) {
    studioValues.x_studio_delivery_notes = deliveryNotes;
  }

  const preferredDeliveryDate = input.preferredDeliveryDate?.trim();
  if (preferredDeliveryDate) {
    studioValues.x_studio_preferred_delivery_date = preferredDeliveryDate;
  }

  const phoneNumber = input.phoneNumber?.trim();
  if (phoneNumber) {
    studioValues.x_studio_phonenumber = phoneNumber;
  }

  const salePersonName = input.salePersonName?.trim();
  const salePersonField = salePersonName
    ? await resolveSalePersonFieldName(session)
    : '';
  if (salePersonName && salePersonField) {
    studioValues[salePersonField] = salePersonName;
  }

  // Always create via the login session when Studio fields are present so they
  // are not dropped by the API-key path.
  let quotationId: number;
  if (Object.keys(studioValues).length > 0) {
    try {
      quotationId = await createOdooRecordAsUser(session, 'sale.order', {
        ...values,
        ...studioValues,
      });
    } catch {
      quotationId = await createOdooRecordAsUser(session, 'sale.order', values);
      for (const [field, value] of Object.entries(studioValues)) {
        try {
          await writeOdooRecordAsUser(session, 'sale.order', quotationId, {
            [field]: value,
          });
        } catch (error) {
          if (field === salePersonField) {
            throw error instanceof Error
              ? error
              : new Error(`Failed to write Sale Person Name (${field}).`);
          }
          console.error(
            `[quotations] Failed to write studio field ${field}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
  } else {
    quotationId = await createOdooRecord(session, 'sale.order', values);
  }

  // Force-write Sale Person Name after create (covers cases where create
  // accepted the vals but did not persist the Studio column).
  if (salePersonName && salePersonField) {
    await writeOdooRecordAsUser(session, 'sale.order', quotationId, {
      [salePersonField]: salePersonName,
    });

    // Also try API-key write when available (same uid).
    if (env.odooApiKey) {
      try {
        await odooExecuteKw(session.uid, 'sale.order', 'write', [
          [quotationId],
          { [salePersonField]: salePersonName },
        ]);
      } catch {
        // Cookie write is authoritative; API-key write is best-effort.
      }
    }

    const verify = await readOdooRecordAsUser<Record<string, string | false>>(
      session,
      'sale.order',
      quotationId,
      [salePersonField],
    );
    const saved = String(verify?.[salePersonField] || '').trim();
    if (saved !== salePersonName) {
      throw new Error(
        `Sale Person Name was not saved to Odoo field "${salePersonField}" (expected "${salePersonName}", got "${saved || '(empty)'}"). Ask an Odoo admin to confirm the field is stored (not related) and writable for your user.`,
      );
    }
  }

  const created = await readOdooRecordAsUser<{ id: number; name: string }>(
    session,
    'sale.order',
    quotationId,
    ['id', 'name'],
  );

  return {
    id: quotationId,
    name: created?.name ?? String(quotationId),
  };
}

async function searchReadOdooRecords<T>(
  session: { cookie: string; uid: number },
  model: string,
  domain: unknown[],
  fields: string[],
  kwargs: Record<string, unknown> = {},
): Promise<T[]> {
  if (env.odooApiKey) {
    try {
      const rows = await odooExecuteKw<T[]>(
        session.uid,
        model,
        'search_read',
        [domain, fields],
        kwargs,
      );

      if (Array.isArray(rows)) {
        return rows;
      }
    } catch {
      // API key search_read can fail; fall back to the login session.
    }
  }

  return odooCallKw<T[]>(session.cookie, model, 'search_read', [domain, fields], kwargs);
}

export async function fetchOdooQuotations(
  userId: string,
  options?: { limit?: number; offset?: number },
): Promise<OdooQuotation[]> {
  const session = getOdooSession(userId);

  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const limit =
    options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
      ? Math.min(Math.floor(options.limit), 500)
      : 1000;
  const offset =
    options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
      ? Math.floor(options.offset)
      : 0;

  const response = await fetch(`${env.odooUrl}/web/dataset/call_kw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookie,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        model: 'sale.order',
        method: 'search_read',
        args: [[], QUOTATION_LIST_FIELDS],
        kwargs: {
          order: 'create_date desc',
          limit,
          offset,
        },
      },
      id: Date.now(),
    }),
  });

  const data = (await response.json()) as JsonRpcResponse<OdooQuotation[]>;

  if (data.error) {
    const message =
      data.error.data?.message ??
      data.error.message ??
      'Failed to load quotations.';
    throw new Error(message);
  }

  return data.result ?? [];
}

export async function fetchOdooQuotationById(
  userId: string,
  quotationId: number,
): Promise<OdooQuotationDetail | null> {
  const session = getOdooSession(userId);

  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  // Prefer the login session to avoid API-key timeout + cookie fallback latency.
  const detail = await readOdooRecordAsUser<OdooQuotationDetail>(
    session,
    'sale.order',
    quotationId,
    QUOTATION_DETAIL_FIELDS,
  );

  if (detail) {
    return detail;
  }

  return readOdooRecordAsUser<OdooQuotationDetail>(
    session,
    'sale.order',
    quotationId,
    QUOTATION_LIST_FIELDS,
  );
}

/** Header + lines + shipping address for the detail screen (parallelized). */
export async function fetchOdooQuotationDetailBundle(
  userId: string,
  quotationId: number,
): Promise<{
  quotation: OdooQuotationDetail;
  lines: OdooOrderLine[];
  partnerAddress: { formatted: string; phone: string };
} | null> {
  const quotation = await fetchOdooQuotationById(userId, quotationId);
  if (!quotation) {
    return null;
  }

  const shippingPartnerId =
    odooRelationId(quotation.partner_shipping_id) ||
    odooRelationId(quotation.partner_id);

  const [lines, partnerAddress] = await Promise.all([
    fetchOdooQuotationLines(userId, quotationId),
    shippingPartnerId
      ? fetchOdooPartnerAddress(userId, shippingPartnerId, {
          resolveTownship: false,
        })
      : Promise.resolve({ formatted: '', phone: '' }),
  ]);

  return { quotation, lines, partnerAddress };
}

/**
 * Cancel a draft quotation in Odoo (`action_cancel`).
 * Only allowed when state is `draft` (UI label: Quotation).
 */
export async function cancelOdooQuotation(
  userId: string,
  quotationId: number,
): Promise<OdooQuotationDetail> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const existing = await fetchOdooQuotationById(userId, quotationId);
  if (!existing) {
    throw new Error('Quotation not found.');
  }

  const state = String(existing.state || '');
  if (state !== 'draft') {
    throw new Error(
      'Only quotations in Quotation status can be cancelled.',
    );
  }

  try {
    await odooCallKw(session.cookie, 'sale.order', 'action_cancel', [
      [quotationId],
    ]);
  } catch (cookieError) {
    try {
      await odooExecuteKw(session.uid, 'sale.order', 'action_cancel', [
        [quotationId],
      ]);
    } catch {
      throw cookieError instanceof Error
        ? cookieError
        : new Error('Failed to cancel quotation in Odoo.');
    }
  }

  const updated = await fetchOdooQuotationById(userId, quotationId);
  if (!updated) {
    throw new Error('Quotation was cancelled but could not be reloaded.');
  }
  return updated;
}

export async function fetchOdooPaymentMethodLines(
  userId: string,
): Promise<{ id: number; name: string }[]> {
  const session = getOdooSession(userId);

  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  let rows: {
    id: number;
    name: string | false;
    payment_method_id: [number, string] | false;
    journal_id: [number, string] | false;
    payment_type: string | false;
  }[] = [];

  try {
    rows = await searchReadOdooRecords(
      session,
      'account.payment.method.line',
      [['payment_type', '=', 'inbound']],
      ['id', 'name', 'payment_method_id', 'journal_id', 'payment_type'],
      { order: 'journal_id asc, id asc', limit: 500 },
    );
  } catch {
    rows = await searchReadOdooRecords(
      session,
      'account.payment.method.line',
      [],
      ['id', 'name', 'payment_method_id', 'journal_id', 'payment_type'],
      { order: 'journal_id asc, id asc', limit: 500 },
    );
  }

  const byJournal = new Map<number, { id: number; name: string }>();

  for (const row of rows) {
    if (row.payment_type && row.payment_type !== 'inbound') {
      continue;
    }

    const journalId = odooRelationId(row.journal_id);
    if (!journalId || byJournal.has(journalId)) {
      continue;
    }

    const journal = odooRelationLabel(row.journal_id);
    const methodName =
      odooString(row.name) || odooRelationLabel(row.payment_method_id);
    const name = journal || methodName || `Payment method ${row.id}`;

    byJournal.set(journalId, { id: row.id, name });
  }

  return Array.from(byJournal.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function odooString(value: unknown): string {
  if (value === false || value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function odooRelationLabel(value: unknown): string {
  if (Array.isArray(value) && value[1]) {
    return odooString(value[1]);
  }
  return '';
}

function odooRelationId(value: unknown): number {
  if (Array.isArray(value) && typeof value[0] === 'number') {
    return value[0];
  }
  return 0;
}

/** Merges partner address with linked Township record (city/state/zip/country). */
export function resolvePartnerLocation(
  partner: PartnerLocationSource,
  township: OdooTownship | null,
): ResolvedPartnerLocation {
  const townshipLabel =
    odooRelationLabel(partner[PARTNER_TOWNSHIP_FIELD]) ||
    (township ? odooString(township.x_name) : '');

  const city =
    odooString(partner.city) ||
    (township ? odooString(township.x_name) : '') ||
    townshipLabel;
  const state =
    odooRelationLabel(partner.state_id) ||
    odooRelationLabel(township?.x_studio_state_link);
  const stateId =
    odooRelationId(partner.state_id) ||
    odooRelationId(township?.x_studio_state_link) ||
    null;
  const zip =
    odooString(partner.zip) || odooString(township?.x_studio_postal_code);
  const country =
    odooRelationLabel(partner.country_id) ||
    odooRelationLabel(township?.x_studio_country_link);
  const countryId =
    odooRelationId(partner.country_id) ||
    odooRelationId(township?.x_studio_country_link) ||
    null;

  return {
    township: townshipLabel,
    city,
    state,
    stateId: stateId || null,
    zip,
    country,
    countryId: countryId || null,
  };
}

type OdooTownshipListItem = {
  id: number;
  x_name: string | false;
};

export async function fetchOdooTownships(
  userId: string,
): Promise<OdooTownshipListItem[]> {
  if (!env.odooTownshipModel) {
    return [];
  }

  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  try {
    return await searchReadOdooRecords<OdooTownshipListItem>(
      session,
      env.odooTownshipModel,
      [],
      ['id', 'x_name'],
      { order: 'x_name asc', limit: 5000 },
    );
  } catch {
    return [];
  }
}

export type CreateContactInput = {
  name: string;
  email?: string;
  phone?: string;
  street?: string;
  street2?: string;
  townshipId?: number;
  tagIds?: number[];
  tagNames?: string[];
  parentId?: number;
  type?: 'contact' | 'delivery' | 'invoice' | 'other';
};

export async function fetchOdooPartnerTags(
  userId: string,
): Promise<{ id: number; name: string }[]> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  return searchReadOdooRecords<{ id: number; name: string }>(
    session,
    'res.partner.category',
    [],
    ['id', 'name'],
    { order: 'name asc', limit: 1000 },
  );
}

export async function resolveOdooPartnerTagIds(
  userId: string,
  options: { tagIds?: number[]; tagNames?: string[] },
): Promise<number[]> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const ids = new Set<number>();

  for (const tagId of options.tagIds ?? []) {
    if (Number.isFinite(tagId) && tagId > 0) {
      ids.add(tagId);
    }
  }

  if (ids.size > 0) {
    const rows = await readOdooRecords<{ id: number }>(
      session,
      'res.partner.category',
      [...ids],
      ['id'],
    );
    return rows.map(row => row.id).filter(id => id > 0);
  }

  for (const tagName of options.tagNames ?? []) {
    const trimmed = tagName.trim();
    if (!trimmed) {
      continue;
    }

    const existing = await searchReadOdooRecords<{ id: number; name: string }>(
      session,
      'res.partner.category',
      [[['name', '=', trimmed]]],
      ['id', 'name'],
      { limit: 1 },
    );

    if (existing[0]?.id) {
      ids.add(existing[0].id);
    }
  }

  return [...ids];
}

export type OdooContactSearchResult = {
  id: number;
  name: string;
  phone: string | false;
  street: string | false;
  street2: string | false;
  city: string | false;
  is_company: boolean;
  parent_id: [number, string] | false;
  type: string | false;
  x_studio_many2one_field_8u9_1jp4l7r0g: [number, string] | false;
};

export async function searchOdooContactsByPhone(
  userId: string,
  phone: string,
): Promise<OdooContactSearchResult[]> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const normalized = normalizeMyanmarPhone(phone);
  const last7 = lastPhoneDigits(phone, 7);

  const rows = await searchReadOdooRecords<OdooContactSearchResult>(
    session,
    'res.partner',
    [
      '|',
      ['phone', 'ilike', normalized],
      ['phone', 'ilike', last7],
    ],
    [
      'id',
      'name',
      'phone',
      'street',
      'street2',
      'city',
      'is_company',
      'parent_id',
      'type',
      PARTNER_TOWNSHIP_FIELD,
    ],
    { limit: 20, order: 'name asc' },
  );

  return rows.filter(row => {
    const storedPhone = odooString(row.phone);
    if (!storedPhone) {
      return false;
    }

    const storedNormalized = normalizeMyanmarPhone(storedPhone);
    if (storedNormalized === normalized) {
      return true;
    }

    return (
      last7.length >= 7 &&
      lastPhoneDigits(storedNormalized, 7) === last7
    );
  });
}

export async function createOdooContact(
  userId: string,
  input: CreateContactInput,
): Promise<{ id: number; name: string }> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const name = input.name.trim();
  if (!name) {
    throw new Error('Name is required.');
  }

  const phone = input.phone?.trim();
  const isChildAddress =
    input.parentId !== undefined &&
    Number.isFinite(input.parentId) &&
    input.parentId > 0;

  if (phone && !isChildAddress) {
    const existing = await searchOdooContactsByPhone(userId, phone);
    if (existing.length > 0) {
      throw new Error(
        'A contact with this phone number already exists. Open the existing contact instead of creating a new one.',
      );
    }
  }

  const values: Record<string, unknown> = {
    name,
    customer_rank: isChildAddress ? 0 : 1,
  };

  if (isChildAddress) {
    values.parent_id = input.parentId;
    values.type = input.type ?? 'delivery';
  }

  const email = input.email?.trim();
  if (email) {
    values.email = email;
  }

  if (phone) {
    values.phone = phone;
  }

  const street = input.street?.trim();
  if (street) {
    values.street = street;
  }

  const street2 = input.street2?.trim();
  if (street2) {
    values.street2 = street2;
  }

  if (
    input.townshipId !== undefined &&
    Number.isFinite(input.townshipId) &&
    input.townshipId > 0
  ) {
    values[PARTNER_TOWNSHIP_FIELD] = input.townshipId;
  }

  const tagIds = await resolveOdooPartnerTagIds(userId, {
    tagIds: input.tagIds,
    tagNames: input.tagIds?.length ? undefined : input.tagNames,
  });

  if (tagIds.length > 0) {
    values.category_id = [[6, 0, tagIds]];
  }

  const contactId = await createOdooRecord(session, 'res.partner', values);

  return {
    id: contactId,
    name,
  };
}

export type PartnerAddressOption = {
  id: number;
  name: string;
  phone: string;
  street: string;
  street2: string;
  city: string;
  township: string;
  parentId: number | null;
  isCompany: boolean;
  isMain: boolean;
  type: string;
  label: string;
};

type OdooAddressPartner = {
  id: number;
  name: string;
  phone: string | false;
  street: string | false;
  street2: string | false;
  city: string | false;
  is_company: boolean;
  parent_id: [number, string] | false;
  type: string | false;
  x_studio_many2one_field_8u9_1jp4l7r0g: [number, string] | false;
};

const ADDRESS_PARTNER_FIELDS = [
  'id',
  'name',
  'phone',
  'street',
  'street2',
  'city',
  'is_company',
  'parent_id',
  'type',
  PARTNER_TOWNSHIP_FIELD,
];

function buildAddressLabel(partner: OdooAddressPartner, township: string, isMain: boolean): string {
  const place = [township, odooString(partner.city), odooString(partner.street)]
    .filter(Boolean)
    .join(' · ');
  const name = odooString(partner.name) || (isMain ? 'Main address' : 'Address');
  if (isMain) {
    return place ? `Main · ${name} (${place})` : `Main · ${name}`;
  }
  return place ? `${name} (${place})` : name;
}

async function mapAddressOption(
  userId: string,
  partner: OdooAddressPartner,
  isMain: boolean,
): Promise<PartnerAddressOption> {
  const townshipRecord = await fetchOdooTownshipForPartner(userId, partner);
  const location = resolvePartnerLocation(partner, townshipRecord);
  const township = location.township;
  const type = odooString(partner.type) || (isMain ? 'contact' : 'delivery');

  return {
    id: partner.id,
    name: odooString(partner.name),
    phone: odooString(partner.phone),
    street: odooString(partner.street),
    street2: odooString(partner.street2),
    city: location.city,
    township,
    parentId: odooRelationId(partner.parent_id) || null,
    isCompany: Boolean(partner.is_company),
    isMain,
    type,
    label: buildAddressLabel(partner, township, isMain),
  };
}

export async function fetchOdooPartnerAddressOptions(
  userId: string,
  partnerId: number,
): Promise<{
  companyId: number;
  companyName: string;
  company: PartnerAddressOption;
  defaultAddressId: number;
  addresses: PartnerAddressOption[];
}> {
  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    throw new Error('A valid customer is required.');
  }

  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const selected = await readOdooRecord<OdooAddressPartner>(
    session,
    'res.partner',
    partnerId,
    ADDRESS_PARTNER_FIELDS,
  );

  if (!selected) {
    throw new Error('Contact not found.');
  }

  const parentId = odooRelationId(selected.parent_id);
  const companyId = parentId || selected.id;

  const company =
    companyId === selected.id
      ? selected
      : await readOdooRecord<OdooAddressPartner>(
          session,
          'res.partner',
          companyId,
          ADDRESS_PARTNER_FIELDS,
        );

  if (!company) {
    throw new Error('Company contact not found.');
  }

  const children = await searchReadOdooRecords<OdooAddressPartner>(
    session,
    'res.partner',
    [['parent_id', '=', companyId]],
    ADDRESS_PARTNER_FIELDS,
    { order: 'name asc', limit: 200 },
  );

  const deliveryChildren = children.filter(child => {
    const type = odooString(child.type).toLowerCase();
    return !type || type === 'delivery' || type === 'other' || type === 'contact';
  });

  const companyOption = await mapAddressOption(userId, company, true);
  const childOptions = await Promise.all(
    deliveryChildren.map(child => mapAddressOption(userId, child, false)),
  );

  const addresses = [companyOption, ...childOptions];
  const defaultAddressId = addresses.some(item => item.id === partnerId)
    ? partnerId
    : companyId;

  return {
    companyId,
    companyName: companyOption.name,
    company: companyOption,
    defaultAddressId,
    addresses,
  };
}

export async function fetchOdooTownshipById(
  userId: string,
  townshipId: number,
): Promise<OdooTownship | null> {
  if (!env.odooTownshipModel || !Number.isFinite(townshipId) || townshipId <= 0) {
    return null;
  }

  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  try {
    return await readOdooRecord<OdooTownship>(
      session,
      env.odooTownshipModel,
      townshipId,
      TOWNSHIP_FIELDS,
    );
  } catch {
    return null;
  }
}

export async function fetchOdooTownshipForPartner(
  userId: string,
  partner: PartnerLocationSource,
): Promise<OdooTownship | null> {
  const townshipId = odooRelationId(partner[PARTNER_TOWNSHIP_FIELD]);
  if (!townshipId) {
    return null;
  }
  return fetchOdooTownshipById(userId, townshipId);
}

export function formatOdooPartnerAddress(
  partner: OdooPartnerAddress,
  location: ResolvedPartnerLocation,
): string {
  const parts = [
    odooString(partner.street),
    odooString(partner.street2),
    location.township || location.city,
    location.state,
    location.zip,
    location.country,
  ].filter(Boolean);

  return parts.join(', ');
}

export async function fetchOdooPartnerAddress(
  userId: string,
  partnerId: number,
  options?: { resolveTownship?: boolean },
): Promise<{ formatted: string; phone: string }> {
  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    return { formatted: '', phone: '' };
  }

  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const partner = await readOdooRecordAsUser<OdooPartnerAddress>(
    session,
    'res.partner',
    partnerId,
    PARTNER_ADDRESS_FIELDS,
  );

  if (!partner) {
    return { formatted: '', phone: '' };
  }

  // Township many2one already includes [id, name] — skip extra township
  // record fetch unless a caller needs postal/state enrichment.
  const township =
    options?.resolveTownship === false
      ? null
      : await fetchOdooTownshipForPartner(userId, partner);
  const location = resolvePartnerLocation(partner, township);

  return {
    formatted: formatOdooPartnerAddress(partner, location),
    phone: odooString(partner.phone),
  };
}

export async function fetchOdooQuotationLines(
  userId: string,
  quotationId: number,
): Promise<OdooOrderLine[]> {
  const session = getOdooSession(userId);

  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  // Cookie session only — avoids API-key attempt latency on the detail path.
  return odooCallKw<OdooOrderLine[]>(
    session.cookie,
    'sale.order.line',
    'search_read',
    [
      [['order_id', '=', quotationId]],
      ORDER_LINE_FIELDS,
    ],
    { order: 'sequence asc, id asc' },
  );
}

export async function fetchOdooContacts(userId: string): Promise<OdooContact[]> {
  const session = getOdooSession(userId);

  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const fields = [
    ...CONTACT_BASE_FIELDS,
    ...Object.keys(CONTACT_CUSTOM_FIELDS),
    ...CONTACT_EXTRA_FIELDS,
  ];

  // Odoo search_read is capped per call; page until exhausted so Contacts
  // is not stuck at the old hard limit of 1000.
  const pageSize = 500;
  const maxPages = 100;
  const all: OdooContact[] = [];

  for (let page = 0; page < maxPages; page += 1) {
    const rows = await searchReadOdooRecords<OdooContact>(
      session,
      'res.partner',
      [],
      fields,
      {
        order: 'name asc',
        limit: pageSize,
        offset: page * pageSize,
      },
    );

    if (!rows.length) {
      break;
    }

    all.push(...rows);

    if (rows.length < pageSize) {
      break;
    }
  }

  return all;
}

/** Lean contact list for New Quotation — fewer fields, customers only. */
export async function fetchOdooContactsForQuotation(
  userId: string,
  options?: { limit?: number; offset?: number; q?: string },
): Promise<OdooContact[]> {
  const session = getOdooSession(userId);

  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const fields = [...CONTACT_BASE_FIELDS, PARTNER_TOWNSHIP_FIELD];
  const limit =
    options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
      ? Math.min(Math.floor(options.limit), 500)
      : 500;
  const offset =
    options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
      ? Math.floor(options.offset)
      : 0;

  const q = String(options?.q ?? '').trim();
  const domain: unknown[] = [['customer_rank', '>', 0]];
  if (q) {
    const phoneClauses: unknown[] = [
      ['name', 'ilike', q],
      ['phone', 'ilike', q],
      ['email', 'ilike', q],
    ];
    const phoneNorm = normalizeMyanmarPhone(q);
    if (phoneNorm && phoneNorm !== q) {
      phoneClauses.push(['phone', 'ilike', phoneNorm]);
    }
    const last7 = lastPhoneDigits(q, 7);
    if (last7.length >= 7) {
      phoneClauses.push(['phone', 'ilike', last7]);
    }
    for (let i = 0; i < phoneClauses.length - 1; i += 1) {
      domain.push('|');
    }
    domain.push(...phoneClauses);
  }

  return searchReadOdooRecords<OdooContact>(
    session,
    'res.partner',
    domain,
    fields,
    {
      order: 'name asc',
      limit,
      offset,
    },
  );
}

export async function fetchOdooContactById(
  userId: string,
  contactId: number,
): Promise<OdooContactDetail | null> {
  const session = getOdooSession(userId);

  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  return readOdooRecord<OdooContactDetail>(
    session,
    'res.partner',
    contactId,
    CONTACT_DETAIL_FIELDS,
  );
}

/** @temp-feature app-install-call-list — only used by Call List; delete with that feature. */
export async function fetchOdooContactsByIds(
  userId: string,
  contactIds: number[],
): Promise<OdooContact[]> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const ids = [...new Set(contactIds)].filter(
    id => Number.isFinite(id) && id > 0,
  );
  if (ids.length === 0) {
    return [];
  }

  const fields = [
    ...CONTACT_BASE_FIELDS,
    ...Object.keys(CONTACT_CUSTOM_FIELDS),
    ...CONTACT_EXTRA_FIELDS,
  ];

  return searchReadOdooRecords<OdooContact>(
    session,
    'res.partner',
    [['id', 'in', ids]],
    fields,
    { limit: ids.length, order: 'name asc' },
  );
}

export async function fetchOdooPartnerCategoryNames(
  userId: string,
  categoryIds: number[],
): Promise<string[]> {
  const session = getOdooSession(userId);

  if (!session || categoryIds.length === 0) {
    return [];
  }

  const rows = await readOdooRecords<{ id: number; name: string }>(
    session,
    'res.partner.category',
    categoryIds,
    ['name'],
  );

  return rows.map(row => row.name).filter(Boolean);
}

async function readOdooRecords<T>(
  session: { cookie: string; uid: number },
  model: string,
  recordIds: number[],
  fields: string[],
): Promise<T[]> {
  if (recordIds.length === 0) {
    return [];
  }

  if (env.odooApiKey) {
    try {
      const rows = await odooExecuteKw<T[]>(
        session.uid,
        model,
        'read',
        [recordIds, fields],
      );
      if (Array.isArray(rows)) {
        return rows;
      }
    } catch {
      // Fall back to the browser session below.
    }
  }

  return odooCallKw<T[]>(session.cookie, model, 'read', [recordIds, fields]);
}

/* ─── Membership (x_membership) & Coupon Tickets (x_membership_coupon_ti) ─── */

export type OdooMembership = {
  id: number;
  x_name: string | false;
  x_studio_customer: [number, string] | false;
  x_studio_membership_level: string | false;
  x_studio_pricelist: [number, string] | false;
  x_studio_start_date: string | false;
  x_studio_end_date: string | false;
  x_studio_status: string | false;
  x_studio_monthly_coupon_amount: number;
  x_studio_total_tickets: number;
  x_studio_used_tickets: number;
  x_studio_missed_tickets: number;
  x_studio_remaining_tickets: number;
  x_studio_benefits_summary: string | false;
};

export type OdooMembershipCouponTicket = {
  id: number;
  x_name: string | false;
  x_studio_membership: [number, string] | false;
  x_studio_customer: [number, string] | false;
  x_studio_used_date: string | false;
  x_studio_partner_id: [number, string] | false;
  x_studio_currency: [number, string] | false;
  x_studio_used_sale_order: [number, string] | false;
  x_studio_status: string | false;
  x_studio_coupon_program: string | false;
  x_studio_coupon_amount: number;
  x_studio_currency_id: [number, string] | false;
  x_studio_ticket_month: string | false;
  x_studio_coupon_code: string | false;
};

const MEMBERSHIP_FIELDS = [
  'id',
  'x_name',
  'x_studio_customer',
  'x_studio_membership_level',
  'x_studio_pricelist',
  'x_studio_start_date',
  'x_studio_end_date',
  'x_studio_status',
  'x_studio_monthly_coupon_amount',
  'x_studio_total_tickets',
  'x_studio_used_tickets',
  'x_studio_missed_tickets',
  'x_studio_remaining_tickets',
  'x_studio_benefits_summary',
];

const MEMBERSHIP_COUPON_FIELDS = [
  'id',
  'x_name',
  'x_studio_membership',
  'x_studio_customer',
  'x_studio_used_date',
  'x_studio_partner_id',
  'x_studio_currency',
  'x_studio_used_sale_order',
  'x_studio_status',
  'x_studio_coupon_program',
  'x_studio_coupon_amount',
  'x_studio_currency_id',
  'x_studio_ticket_month',
  'x_studio_coupon_code',
];

export async function fetchOdooMemberships(
  userId: string,
  options?: { limit?: number; offset?: number; q?: string },
): Promise<OdooMembership[]> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const limit =
    options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
      ? Math.min(Math.floor(options.limit), 500)
      : 200;
  const offset =
    options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
      ? Math.floor(options.offset)
      : 0;

  const q = options?.q?.trim();
  const domain: unknown[] = q
    ? [
        '|',
        '|',
        ['x_name', 'ilike', q],
        ['x_studio_customer', 'ilike', q],
        ['x_studio_status', 'ilike', q],
      ]
    : [];

  return searchReadOdooRecords<OdooMembership>(
    session,
    'x_membership',
    domain,
    MEMBERSHIP_FIELDS,
    { order: 'id desc', limit, offset },
  );
}

export async function fetchOdooMembershipById(
  userId: string,
  membershipId: number,
): Promise<OdooMembership | null> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }
  return readOdooRecordAsUser<OdooMembership>(
    session,
    'x_membership',
    membershipId,
    MEMBERSHIP_FIELDS,
  );
}

export async function fetchOdooMembershipCouponTickets(
  userId: string,
  options?: { limit?: number; offset?: number; q?: string; membershipId?: number },
): Promise<OdooMembershipCouponTicket[]> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const limit =
    options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
      ? Math.min(Math.floor(options.limit), 500)
      : 200;
  const offset =
    options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
      ? Math.floor(options.offset)
      : 0;

  const domain: unknown[] = [];
  if (
    options?.membershipId !== undefined &&
    Number.isFinite(options.membershipId) &&
    options.membershipId > 0
  ) {
    domain.push(['x_studio_membership', '=', options.membershipId]);
  }

  const q = options?.q?.trim();
  if (q) {
    const search: unknown[] = [
      '|',
      '|',
      '|',
      ['x_name', 'ilike', q],
      ['x_studio_coupon_code', 'ilike', q],
      ['x_studio_customer', 'ilike', q],
      ['x_studio_status', 'ilike', q],
    ];
    if (domain.length > 0) {
      domain.unshift('&');
    }
    domain.push(...search);
  }

  return searchReadOdooRecords<OdooMembershipCouponTicket>(
    session,
    'x_membership_coupon_ti',
    domain,
    MEMBERSHIP_COUPON_FIELDS,
    { order: 'id desc', limit, offset },
  );
}

export async function fetchOdooMembershipCouponTicketById(
  userId: string,
  ticketId: number,
): Promise<OdooMembershipCouponTicket | null> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }
  return readOdooRecordAsUser<OdooMembershipCouponTicket>(
    session,
    'x_membership_coupon_ti',
    ticketId,
    MEMBERSHIP_COUPON_FIELDS,
  );
}

/* ─── Membership Application / Member Request (x_membership_applicati) ─── */

export const MEMBERSHIP_APPLICATION_MODEL = 'x_membership_applicati';

export const MEMBER_REQUEST_STATUSES = [
  'Requested',
  'Approved',
  'Rejected',
] as const;

export type MemberRequestStatus = (typeof MEMBER_REQUEST_STATUSES)[number];

export const MEMBER_REQUEST_PLANS = ['Premium', 'Pro'] as const;

export type OdooMembershipApplication = {
  id: number;
  x_studio_customer: [number, string] | false;
  x_studio_selection_field_2c0_1jvv3u0te: string | false;
  x_studio_name: string | false;
  x_studio_phone: string | false;
  x_studio_email: string | false;
  x_studio_status: string | false;
  x_studio_requested_at: string | false;
  x_studio_notes_1: string | false;
};

const MEMBERSHIP_APPLICATION_FIELDS = [
  'id',
  'x_studio_customer',
  'x_studio_selection_field_2c0_1jvv3u0te',
  'x_studio_name',
  'x_studio_phone',
  'x_studio_email',
  'x_studio_status',
  'x_studio_requested_at',
  'x_studio_notes_1',
];

export function isMemberRequestStatus(value: unknown): value is MemberRequestStatus {
  return (
    typeof value === 'string' &&
    (MEMBER_REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

export async function fetchOdooMembershipApplications(
  userId: string,
  options?: {
    limit?: number;
    offset?: number;
    q?: string;
    status?: string;
  },
): Promise<OdooMembershipApplication[]> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const limit =
    options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
      ? Math.min(Math.floor(options.limit), 500)
      : 200;
  const offset =
    options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
      ? Math.floor(options.offset)
      : 0;

  const domain: unknown[] = [];
  const status = String(options?.status ?? '').trim();
  if (status) {
    domain.push(['x_studio_status', '=', status]);
  }

  const q = options?.q?.trim();
  if (q) {
    domain.push('|');
    domain.push('|');
    domain.push('|');
    domain.push('|');
    domain.push(['x_studio_name', 'ilike', q]);
    domain.push(['x_studio_phone', 'ilike', q]);
    domain.push(['x_studio_email', 'ilike', q]);
    domain.push(['x_studio_customer', 'ilike', q]);
    domain.push(['x_studio_notes_1', 'ilike', q]);
  }

  return searchReadOdooRecords<OdooMembershipApplication>(
    session,
    MEMBERSHIP_APPLICATION_MODEL,
    domain,
    MEMBERSHIP_APPLICATION_FIELDS,
    { order: 'x_studio_requested_at desc, id desc', limit, offset },
  );
}

export async function countOdooMembershipApplications(
  userId: string,
  options?: { status?: string },
): Promise<number> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const domain: unknown[] = [];
  const status = String(options?.status ?? '').trim();
  if (status) {
    domain.push(['x_studio_status', '=', status]);
  }

  try {
    if (env.odooApiKey) {
      const count = await odooExecuteKw<number>(
        session.uid,
        MEMBERSHIP_APPLICATION_MODEL,
        'search_count',
        [domain],
      );
      if (typeof count === 'number' && Number.isFinite(count)) {
        return count;
      }
    }
  } catch {
    // Fall through to session cookie call.
  }

  return odooCallKw<number>(
    session.cookie,
    MEMBERSHIP_APPLICATION_MODEL,
    'search_count',
    [domain],
  );
}

export async function fetchOdooMembershipApplicationById(
  userId: string,
  applicationId: number,
): Promise<OdooMembershipApplication | null> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }
  return readOdooRecordAsUser<OdooMembershipApplication>(
    session,
    MEMBERSHIP_APPLICATION_MODEL,
    applicationId,
    MEMBERSHIP_APPLICATION_FIELDS,
  );
}

export async function updateOdooMembershipApplicationStatus(
  userId: string,
  applicationId: number,
  status: MemberRequestStatus,
): Promise<OdooMembershipApplication> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  // Studio selection keys may be labels or lowercase / underscore keys.
  const candidates = Array.from(
    new Set([
      status,
      status.toLowerCase(),
      status.toLowerCase().replace(/\s+/g, '_'),
    ]),
  );

  let lastError: unknown;
  for (const value of candidates) {
    try {
      await writeOdooRecordAsUser(
        session,
        MEMBERSHIP_APPLICATION_MODEL,
        applicationId,
        { x_studio_status: value },
      );
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError instanceof Error
      ? lastError
      : new Error('Failed to update member request status.');
  }

  const updated = await fetchOdooMembershipApplicationById(userId, applicationId);
  if (!updated) {
    throw new Error('Member request not found after update.');
  }
  return updated;
}

/* ─── Purchase Order (purchase.order) ─── */

export type OdooPurchaseOrder = {
  id: number;
  name: string;
  date_order: string | false;
  partner_id: [number, string] | false;
  amount_total: number;
  state: string;
  user_id: [number, string] | false;
};

export type OdooPurchaseOrderDetail = OdooPurchaseOrder & {
  amount_untaxed: number;
  currency_id: [number, string] | false;
  date_planned: string | false;
  origin: string | false;
};

export type OdooPurchaseOrderLine = {
  id: number;
  name: string;
  product_id: [number, string] | false;
  product_qty: number;
  price_unit: number;
  price_subtotal: number;
};

const PURCHASE_ORDER_LIST_FIELDS = [
  'id',
  'name',
  'date_order',
  'partner_id',
  'amount_total',
  'state',
  'user_id',
];

const PURCHASE_ORDER_DETAIL_FIELDS = [
  ...PURCHASE_ORDER_LIST_FIELDS,
  'amount_untaxed',
  'currency_id',
  'date_planned',
  'origin',
];

const PURCHASE_ORDER_LINE_FIELDS = [
  'id',
  'name',
  'product_id',
  'product_qty',
  'price_unit',
  'price_subtotal',
];

const PURCHASE_ORDER_LINE_FIELDS_MIN = [
  'id',
  'name',
  'product_id',
  'product_qty',
  'price_unit',
];

export async function fetchOdooPurchaseOrders(
  userId: string,
  options?: { limit?: number; offset?: number; q?: string },
): Promise<OdooPurchaseOrder[]> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const limit =
    options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
      ? Math.min(Math.floor(options.limit), 500)
      : 200;
  const offset =
    options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
      ? Math.floor(options.offset)
      : 0;

  const q = options?.q?.trim();
  const domain: unknown[] = q
    ? ['|', ['name', 'ilike', q], ['partner_id', 'ilike', q]]
    : [];

  return searchReadOdooRecords<OdooPurchaseOrder>(
    session,
    'purchase.order',
    domain,
    PURCHASE_ORDER_LIST_FIELDS,
    { order: 'date_order desc, id desc', limit, offset },
  );
}

export async function fetchOdooPurchaseOrderById(
  userId: string,
  purchaseOrderId: number,
): Promise<OdooPurchaseOrderDetail | null> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  // Detail fields can differ by Odoo version — fall back to list fields on failure.
  try {
    const detail = await readOdooRecordAsUser<OdooPurchaseOrderDetail>(
      session,
      'purchase.order',
      purchaseOrderId,
      PURCHASE_ORDER_DETAIL_FIELDS,
    );
    if (detail) {
      return detail;
    }
  } catch (error) {
    console.warn(
      '[purchase-orders] Detail fields failed, falling back to list fields:',
      error instanceof Error ? error.message : error,
    );
  }

  try {
    return await readOdooRecordAsUser<OdooPurchaseOrderDetail>(
      session,
      'purchase.order',
      purchaseOrderId,
      PURCHASE_ORDER_LIST_FIELDS,
    );
  } catch (error) {
    console.error(
      '[purchase-orders] Failed to read purchase order:',
      error instanceof Error ? error.message : error,
    );
    throw error instanceof Error
      ? error
      : new Error('Failed to load purchase order.');
  }
}

export async function fetchOdooPurchaseOrderLines(
  userId: string,
  purchaseOrderId: number,
): Promise<OdooPurchaseOrderLine[]> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const domain = [['order_id', '=', purchaseOrderId]];

  try {
    return await odooCallKw<OdooPurchaseOrderLine[]>(
      session.cookie,
      'purchase.order.line',
      'search_read',
      [domain, PURCHASE_ORDER_LINE_FIELDS],
      { order: 'id asc' },
    );
  } catch (error) {
    console.warn(
      '[purchase-orders] Line fields failed, retrying with minimal fields:',
      error instanceof Error ? error.message : error,
    );
  }

  try {
    return await odooCallKw<OdooPurchaseOrderLine[]>(
      session.cookie,
      'purchase.order.line',
      'search_read',
      [domain, PURCHASE_ORDER_LINE_FIELDS_MIN],
      { order: 'id asc' },
    );
  } catch (error) {
    console.warn(
      '[purchase-orders] Could not load order lines:',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

export async function fetchOdooPurchaseOrderDetailBundle(
  userId: string,
  purchaseOrderId: number,
): Promise<{
  purchaseOrder: OdooPurchaseOrderDetail;
  lines: OdooPurchaseOrderLine[];
} | null> {
  const purchaseOrder = await fetchOdooPurchaseOrderById(userId, purchaseOrderId);
  if (!purchaseOrder) {
    return null;
  }

  const lines = await fetchOdooPurchaseOrderLines(userId, purchaseOrderId);
  return { purchaseOrder, lines };
}

/* ─── Sale Order (sale.order confirmed: sale / done) — view only ─── */

export type OdooSaleOrder = {
  id: number;
  name: string;
  date_order: string | false;
  partner_id: [number, string] | false;
  amount_total: number;
  state: string;
  user_id: [number, string] | false;
  x_studio_phonenumber_1?: string | false;
  x_studio_phonenumber?: string | false;
  x_studio_sale_person_name?: string | false;
  /** Studio many2one Salesperson (`res.users`) — used for App Order matching. */
  x_studio_salesperson?: [number, string] | false;
};

export type OdooSaleOrderDetail = OdooSaleOrder & {
  amount_untaxed: number;
  currency_id: [number, string] | false;
  commitment_date: string | false;
  client_order_ref: string | false;
  partner_shipping_id: [number, string] | false;
  x_studio_preferred_delivery_date?: string | false;
  x_studio_delivery_notes?: string | false;
};

export type OdooSaleOrderLine = {
  id: number;
  name: string;
  product_id: [number, string] | false;
  product_uom_qty: number;
  price_unit: number;
  price_subtotal: number;
};

const SALE_ORDER_LIST_FIELDS = [
  'id',
  'name',
  'date_order',
  'partner_id',
  'amount_total',
  'state',
  'user_id',
  'x_studio_phonenumber_1',
  'x_studio_phonenumber',
  'x_studio_sale_person_name',
  'x_studio_salesperson',
];

const SALE_ORDER_DETAIL_FIELDS = [
  ...SALE_ORDER_LIST_FIELDS,
  'amount_untaxed',
  'currency_id',
  'commitment_date',
  'client_order_ref',
  'partner_shipping_id',
  'x_studio_preferred_delivery_date',
  'x_studio_delivery_notes',
];

const SALE_ORDER_LINE_FIELDS = [
  'id',
  'name',
  'product_id',
  'product_uom_qty',
  'price_unit',
  'price_subtotal',
];

const SALE_ORDER_LINE_FIELDS_MIN = [
  'id',
  'name',
  'product_id',
  'product_uom_qty',
  'price_unit',
];

export async function fetchOdooSaleOrders(
  userId: string,
  options?: { limit?: number; offset?: number; q?: string },
): Promise<OdooSaleOrder[]> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const limit =
    options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
      ? Math.min(Math.floor(options.limit), 500)
      : 200;
  const offset =
    options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
      ? Math.floor(options.offset)
      : 0;

  const domain: unknown[] = [['state', 'in', ['sale', 'done']]];
  const q = options?.q?.trim();
  if (q) {
    domain.push('|');
    domain.push('|');
    domain.push(['name', 'ilike', q]);
    domain.push(['partner_id', 'ilike', q]);
    domain.push(['client_order_ref', 'ilike', q]);
  }

  return searchReadOdooRecords<OdooSaleOrder>(
    session,
    'sale.order',
    domain,
    SALE_ORDER_LIST_FIELDS,
    { order: 'date_order desc, id desc', limit, offset },
  );
}

export async function fetchOdooSaleOrderById(
  userId: string,
  saleOrderId: number,
): Promise<OdooSaleOrderDetail | null> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  try {
    const detail = await readOdooRecordAsUser<OdooSaleOrderDetail>(
      session,
      'sale.order',
      saleOrderId,
      SALE_ORDER_DETAIL_FIELDS,
    );
    if (detail) {
      return detail;
    }
  } catch (error) {
    console.warn(
      '[sale-orders] Detail fields failed, falling back to list fields:',
      error instanceof Error ? error.message : error,
    );
  }

  try {
    return await readOdooRecordAsUser<OdooSaleOrderDetail>(
      session,
      'sale.order',
      saleOrderId,
      SALE_ORDER_LIST_FIELDS,
    );
  } catch (error) {
    console.error(
      '[sale-orders] Failed to read sale order:',
      error instanceof Error ? error.message : error,
    );
    throw error instanceof Error
      ? error
      : new Error('Failed to load sale order.');
  }
}

export async function fetchOdooSaleOrderLines(
  userId: string,
  saleOrderId: number,
): Promise<OdooSaleOrderLine[]> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const domain = [['order_id', '=', saleOrderId]];

  try {
    return await odooCallKw<OdooSaleOrderLine[]>(
      session.cookie,
      'sale.order.line',
      'search_read',
      [domain, SALE_ORDER_LINE_FIELDS],
      { order: 'id asc' },
    );
  } catch (error) {
    console.warn(
      '[sale-orders] Line fields failed, retrying with minimal fields:',
      error instanceof Error ? error.message : error,
    );
  }

  try {
    return await odooCallKw<OdooSaleOrderLine[]>(
      session.cookie,
      'sale.order.line',
      'search_read',
      [domain, SALE_ORDER_LINE_FIELDS_MIN],
      { order: 'id asc' },
    );
  } catch (error) {
    console.warn(
      '[sale-orders] Could not load order lines:',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

export async function fetchOdooSaleOrderDetailBundle(
  userId: string,
  saleOrderId: number,
): Promise<{
  saleOrder: OdooSaleOrderDetail;
  lines: OdooSaleOrderLine[];
} | null> {
  const saleOrder = await fetchOdooSaleOrderById(userId, saleOrderId);
  if (!saleOrder) {
    return null;
  }

  // View module: only confirmed sale orders (sale / done).
  const state = String(saleOrder.state || '');
  if (state !== 'sale' && state !== 'done') {
    return null;
  }

  const lines = await fetchOdooSaleOrderLines(userId, saleOrderId);
  return { saleOrder, lines };
}

/* ─── App Order (Quotation Sent OR Studio Salesperson = Administrator) ─── */

let cachedAdministratorUserId: number | null | undefined;

/** Resolve Odoo res.users id for Administrator (Studio x_studio_salesperson). */
async function resolveAdministratorUserId(
  session: { cookie: string; uid: number },
): Promise<number | null> {
  if (cachedAdministratorUserId !== undefined) {
    return cachedAdministratorUserId;
  }

  try {
    const rows = await odooCallKw<{ id: number; name?: string; login?: string }[]>(
      session.cookie,
      'res.users',
      'search_read',
      [
        [
          '|',
          ['login', '=', 'admin'],
          ['name', '=ilike', 'Administrator'],
        ],
        ['id', 'name', 'login'],
      ],
      { order: 'id asc', limit: 5 },
    );

    const preferred =
      rows?.find(row => String(row.login || '').toLowerCase() === 'admin') ??
      rows?.find(
        row => String(row.name || '').toLowerCase() === 'administrator',
      ) ??
      rows?.[0];

    cachedAdministratorUserId =
      preferred && Number.isFinite(preferred.id) ? preferred.id : null;
  } catch (error) {
    console.warn(
      '[online-orders] Could not resolve Administrator user:',
      error instanceof Error ? error.message : error,
    );
    cachedAdministratorUserId = null;
  }

  return cachedAdministratorUserId;
}

function isAppOrderSalespersonAdministrator(
  order: {
    x_studio_salesperson?: [number, string] | false;
  },
  administratorUserId: number | null,
): boolean {
  const rel = order.x_studio_salesperson;
  if (!Array.isArray(rel) || typeof rel[0] !== 'number') {
    return false;
  }
  if (administratorUserId !== null && rel[0] === administratorUserId) {
    return true;
  }
  return String(rel[1] || '').trim().toLowerCase() === 'administrator';
}

function buildAppOrderDomain(administratorUserId: number | null): unknown[] {
  // Either Quotation Sent OR Studio Salesperson = Administrator.
  if (administratorUserId !== null) {
    return [
      '|',
      ['state', '=', 'sent'],
      ['x_studio_salesperson', '=', administratorUserId],
    ];
  }
  // Fallback when Administrator user cannot be resolved.
  return [['state', '=', 'sent']];
}

export async function fetchOdooOnlineOrders(
  userId: string,
  options?: { limit?: number; offset?: number; q?: string },
): Promise<OdooSaleOrder[]> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const limit =
    options?.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
      ? Math.min(Math.floor(options.limit), 500)
      : 200;
  const offset =
    options?.offset !== undefined && Number.isFinite(options.offset) && options.offset > 0
      ? Math.floor(options.offset)
      : 0;

  const administratorUserId = await resolveAdministratorUserId(session);
  const domain = buildAppOrderDomain(administratorUserId);
  const q = options?.q?.trim();
  if (q) {
    domain.push('|');
    domain.push('|');
    domain.push('|');
    domain.push('|');
    domain.push(['name', 'ilike', q]);
    domain.push(['partner_id', 'ilike', q]);
    domain.push(['client_order_ref', 'ilike', q]);
    domain.push(['x_studio_phonenumber_1', 'ilike', q]);
    domain.push(['x_studio_sale_person_name', 'ilike', q]);
  }

  try {
    return await searchReadOdooRecords<OdooSaleOrder>(
      session,
      'sale.order',
      domain,
      SALE_ORDER_LIST_FIELDS,
      { order: 'date_order desc, id desc', limit, offset },
    );
  } catch (error) {
    // Older DBs may lack x_studio_salesperson — fall back to Quotation Sent only.
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.toLowerCase().includes('x_studio_salesperson') ||
      message.toLowerCase().includes('invalid field')
    ) {
      console.warn(
        '[online-orders] x_studio_salesperson unavailable, using state=sent only:',
        message,
      );
      const fallbackDomain: unknown[] = [['state', '=', 'sent']];
      if (q) {
        fallbackDomain.push('|');
        fallbackDomain.push('|');
        fallbackDomain.push('|');
        fallbackDomain.push('|');
        fallbackDomain.push(['name', 'ilike', q]);
        fallbackDomain.push(['partner_id', 'ilike', q]);
        fallbackDomain.push(['client_order_ref', 'ilike', q]);
        fallbackDomain.push(['x_studio_phonenumber_1', 'ilike', q]);
        fallbackDomain.push(['x_studio_sale_person_name', 'ilike', q]);
      }
      return searchReadOdooRecords<OdooSaleOrder>(
        session,
        'sale.order',
        fallbackDomain,
        SALE_ORDER_LIST_FIELDS.filter(f => f !== 'x_studio_salesperson'),
        { order: 'date_order desc, id desc', limit, offset },
      );
    }
    throw error;
  }
}

export type AppOrderPartnerStat = {
  count: number;
  lastOrderNumber: string;
  lastOrderDate: string;
};

/**
 * Count App Orders per partner (and capture the latest order number/date).
 * Used by App User List badges beside customer names.
 */
export async function fetchAppOrderStatsByPartnerIds(
  userId: string,
  partnerIds: number[],
): Promise<Map<number, AppOrderPartnerStat>> {
  const stats = new Map<number, AppOrderPartnerStat>();
  const ids = [
    ...new Set(
      partnerIds.filter(id => Number.isFinite(id) && id > 0).map(id => Math.floor(id)),
    ),
  ];
  if (!ids.length) {
    return stats;
  }

  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const administratorUserId = await resolveAdministratorUserId(session);
  const baseDomain = buildAppOrderDomain(administratorUserId);
  const fields = ['partner_id', 'name', 'date_order'] as const;
  const pageSize = 500;
  const maxPages = 20;

  const readPage = async (
    domain: unknown[],
    offset: number,
  ): Promise<
    Array<{
      id: number;
      partner_id: [number, string] | false;
      name: string | false;
      date_order: string | false;
    }>
  > =>
    searchReadOdooRecords(session, 'sale.order', domain, [...fields], {
      order: 'date_order desc, id desc',
      limit: pageSize,
      offset,
    });

  try {
    for (let page = 0; page < maxPages; page += 1) {
      const domain: unknown[] = [...baseDomain, ['partner_id', 'in', ids]];
      let rows: Awaited<ReturnType<typeof readPage>>;
      try {
        rows = await readPage(domain, page * pageSize);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.toLowerCase().includes('x_studio_salesperson') ||
          message.toLowerCase().includes('invalid field')
        ) {
          rows = await readPage(
            [['state', '=', 'sent'], ['partner_id', 'in', ids]],
            page * pageSize,
          );
        } else {
          throw error;
        }
      }

      if (!rows.length) {
        break;
      }

      for (const row of rows) {
        const partnerId = Array.isArray(row.partner_id)
          ? Number(row.partner_id[0])
          : 0;
        if (!partnerId) {
          continue;
        }
        const existing = stats.get(partnerId);
        if (!existing) {
          stats.set(partnerId, {
            count: 1,
            lastOrderNumber: String(row.name || ''),
            lastOrderDate: String(row.date_order || ''),
          });
        } else {
          existing.count += 1;
        }
      }

      if (rows.length < pageSize) {
        break;
      }
    }
  } catch (error) {
    // Don't fail the whole App User List if order stats cannot load.
    console.error(
      '[app-installs] app-order stats',
      error instanceof Error ? error.message : error,
    );
  }

  return stats;
}

export async function fetchOdooOnlineOrderDetailBundle(
  userId: string,
  saleOrderId: number,
): Promise<{
  saleOrder: OdooSaleOrderDetail;
  lines: OdooSaleOrderLine[];
} | null> {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const saleOrder = await fetchOdooSaleOrderById(userId, saleOrderId);
  if (!saleOrder) {
    return null;
  }

  const administratorUserId = await resolveAdministratorUserId(session);
  const isQuotationSent = String(saleOrder.state || '') === 'sent';
  const isAdminSalesperson = isAppOrderSalespersonAdministrator(
    saleOrder,
    administratorUserId,
  );
  if (!isQuotationSent && !isAdminSalesperson) {
    return null;
  }

  const lines = await fetchOdooSaleOrderLines(userId, saleOrderId);
  return { saleOrder, lines };
}

/* ─── Overview / Insights dashboard ─── */

export type OverviewPeriod = 'day' | 'week' | 'month';

type OverviewPartnerRow = {
  id: number;
  city: string | false;
  [PARTNER_TOWNSHIP_FIELD]: [number, string] | false;
};

type OverviewLineRow = {
  id: number;
  product_id: [number, string] | false;
  price_subtotal: number;
  product_uom_qty: number;
  display_type?: string | false;
};

function yangonParts(date: Date): {
  y: number;
  m: number;
  d: number;
  h: number;
} {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yangon',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) =>
    Number(parts.find(part => part.type === type)?.value ?? '0');
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour') };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function yangonDateKey(date: Date): string {
  const { y, m, d } = yangonParts(date);
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function yangonHourKey(date: Date): string {
  const { y, m, d, h } = yangonParts(date);
  return `${y}-${pad2(m)}-${pad2(d)}T${pad2(h)}`;
}

function parseOdooDate(value: string | false | undefined): Date | null {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  // Odoo often returns naive UTC-like "YYYY-MM-DD HH:mm:ss"
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZ = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const date = new Date(withZ);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildPeriodWindow(period: OverviewPeriod, now = new Date()) {
  const { y, m, d } = yangonParts(now);
  // Approximate Yangon local midnight as UTC+06:30
  const localMidnightUtc = Date.UTC(y, m - 1, d) - 6.5 * 60 * 60 * 1000;

  if (period === 'day') {
    const from = new Date(localMidnightUtc);
    const to = new Date(localMidnightUtc + 24 * 60 * 60 * 1000);
    const prevFrom = new Date(from.getTime() - 24 * 60 * 60 * 1000);
    const prevTo = from;
    const buckets: string[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      buckets.push(`${y}-${pad2(m)}-${pad2(d)}T${pad2(hour)}`);
    }
    return { from, to, prevFrom, prevTo, buckets, bucketMode: 'hour' as const };
  }

  if (period === 'week') {
    // Last 7 calendar days including today (Yangon)
    const to = new Date(localMidnightUtc + 24 * 60 * 60 * 1000);
    const from = new Date(localMidnightUtc - 6 * 24 * 60 * 60 * 1000);
    const prevTo = from;
    const prevFrom = new Date(from.getTime() - 7 * 24 * 60 * 60 * 1000);
    const buckets: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const day = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
      buckets.push(yangonDateKey(day));
    }
    return { from, to, prevFrom, prevTo, buckets, bucketMode: 'day' as const };
  }

  // month: current calendar month in Yangon
  const monthStartUtc = Date.UTC(y, m - 1, 1) - 6.5 * 60 * 60 * 1000;
  const nextMonthStartUtc = Date.UTC(y, m, 1) - 6.5 * 60 * 60 * 1000;
  const from = new Date(monthStartUtc);
  const to = new Date(nextMonthStartUtc);
  const prevMonthStartUtc = Date.UTC(y, m - 2, 1) - 6.5 * 60 * 60 * 1000;
  const prevFrom = new Date(prevMonthStartUtc);
  const prevTo = from;
  const buckets: string[] = [];
  const cursor = new Date(from.getTime());
  while (cursor < to) {
    buckets.push(yangonDateKey(cursor));
    cursor.setTime(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return { from, to, prevFrom, prevTo, buckets, bucketMode: 'day' as const };
}

function toOdooDatetime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function trendPercent(current: number, previous: number): number {
  if (!Number.isFinite(previous) || previous === 0) {
    return current > 0 ? 100 : 0;
  }
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

function areaLabel(partner: OverviewPartnerRow): string {
  const township = Array.isArray(partner[PARTNER_TOWNSHIP_FIELD])
    ? String(partner[PARTNER_TOWNSHIP_FIELD][1] || '').trim()
    : '';
  const city = String(partner.city || '').trim();
  return township || city || 'Unknown area';
}

function sumOrders(orders: OdooSaleOrder[]): number {
  return orders.reduce((sum, order) => sum + (Number(order.amount_total) || 0), 0);
}

export async function fetchOverviewInsights(
  userId: string,
  period: OverviewPeriod,
) {
  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const window = buildPeriodWindow(period);
  const fromStr = toOdooDatetime(window.from);
  const toStr = toOdooDatetime(window.to);
  const prevFromStr = toOdooDatetime(window.prevFrom);
  const prevToStr = toOdooDatetime(window.prevTo);

  const saleDomain: unknown[] = [
    ['state', 'in', ['sale', 'done']],
    ['date_order', '>=', fromStr],
    ['date_order', '<', toStr],
  ];
  const prevSaleDomain: unknown[] = [
    ['state', 'in', ['sale', 'done']],
    ['date_order', '>=', prevFromStr],
    ['date_order', '<', prevToStr],
  ];

  const purchaseDomain: unknown[] = [
    ['state', 'in', ['purchase', 'done']],
    ['date_order', '>=', fromStr],
    ['date_order', '<', toStr],
  ];
  const prevPurchaseDomain: unknown[] = [
    ['state', 'in', ['purchase', 'done']],
    ['date_order', '>=', prevFromStr],
    ['date_order', '<', prevToStr],
  ];

  const [
    saleOrders,
    prevSaleOrders,
    purchaseOrders,
    prevPurchaseOrders,
    quotationCount,
    prevQuotationCount,
    membershipCount,
    prevMembershipCount,
  ] = await Promise.all([
    searchReadOdooRecords<OdooSaleOrder>(
      session,
      'sale.order',
      saleDomain,
      SALE_ORDER_LIST_FIELDS,
      { order: 'date_order desc, id desc', limit: 1000 },
    ),
    searchReadOdooRecords<OdooSaleOrder>(
      session,
      'sale.order',
      prevSaleDomain,
      ['id', 'amount_total', 'partner_id'],
      { limit: 1000 },
    ),
    searchReadOdooRecords<OdooPurchaseOrder>(
      session,
      'purchase.order',
      purchaseDomain,
      PURCHASE_ORDER_LIST_FIELDS,
      { order: 'date_order desc, id desc', limit: 1000 },
    ),
    searchReadOdooRecords<OdooPurchaseOrder>(
      session,
      'purchase.order',
      prevPurchaseDomain,
      ['id', 'amount_total'],
      { limit: 1000 },
    ),
    odooCallKw<number>(session.cookie, 'sale.order', 'search_count', [
      [
        ['date_order', '>=', fromStr],
        ['date_order', '<', toStr],
        ['state', 'in', ['draft', 'sent', 'sale', 'done']],
      ],
    ]),
    odooCallKw<number>(session.cookie, 'sale.order', 'search_count', [
      [
        ['date_order', '>=', prevFromStr],
        ['date_order', '<', prevToStr],
        ['state', 'in', ['draft', 'sent', 'sale', 'done']],
      ],
    ]),
    odooCallKw<number>(session.cookie, 'x_membership', 'search_count', [
      [
        ['x_studio_start_date', '>=', fromStr.slice(0, 10)],
        ['x_studio_start_date', '<', toStr.slice(0, 10)],
      ],
    ]).catch(async () => {
      const rows = await searchReadOdooRecords<{
        id: number;
        x_studio_start_date: string | false;
      }>(
        session,
        'x_membership',
        [],
        ['id', 'x_studio_start_date'],
        { limit: 500 },
      );
      const fromDay = fromStr.slice(0, 10);
      const toDay = toStr.slice(0, 10);
      return rows.filter(row => {
        const start = String(row.x_studio_start_date || '').slice(0, 10);
        return start >= fromDay && start < toDay;
      }).length;
    }),
    odooCallKw<number>(session.cookie, 'x_membership', 'search_count', [
      [
        ['x_studio_start_date', '>=', prevFromStr.slice(0, 10)],
        ['x_studio_start_date', '<', prevToStr.slice(0, 10)],
      ],
    ]).catch(() => 0),
  ]);

  const saleAmount = sumOrders(saleOrders);
  const prevSaleAmount = sumOrders(prevSaleOrders as OdooSaleOrder[]);
  const orderCount = saleOrders.length;
  const prevOrderCount = prevSaleOrders.length;
  const avgOrderValue = orderCount > 0 ? saleAmount / orderCount : 0;
  const prevAvg =
    prevOrderCount > 0 ? prevSaleAmount / prevOrderCount : 0;

  const purchaseAmount = purchaseOrders.reduce(
    (sum, order) => sum + (Number(order.amount_total) || 0),
    0,
  );
  const prevPurchaseAmount = prevPurchaseOrders.reduce(
    (sum, order) => sum + (Number(order.amount_total) || 0),
    0,
  );
  const purchaseOrderCount = purchaseOrders.length;
  const prevPurchaseOrderCount = prevPurchaseOrders.length;

  const buyingCustomerIds = new Set(
    saleOrders
      .map(order =>
        Array.isArray(order.partner_id) ? Number(order.partner_id[0]) : 0,
      )
      .filter(id => id > 0),
  );
  const prevBuyingCustomerIds = new Set(
    (prevSaleOrders as OdooSaleOrder[])
      .map(order =>
        Array.isArray(order.partner_id) ? Number(order.partner_id[0]) : 0,
      )
      .filter(id => id > 0),
  );

  // Partner areas for current-period orders
  const partnerIds = Array.from(buyingCustomerIds);

  let partners: OverviewPartnerRow[] = [];
  if (partnerIds.length > 0) {
    partners = await searchReadOdooRecords<OverviewPartnerRow>(
      session,
      'res.partner',
      [['id', 'in', partnerIds]],
      ['id', 'city', PARTNER_TOWNSHIP_FIELD],
      { limit: partnerIds.length },
    );
  }

  const partnerArea = new Map<number, string>();
  for (const partner of partners) {
    partnerArea.set(partner.id, areaLabel(partner));
  }

  const areaTotals = new Map<string, number>();
  const areaSeriesMap = new Map<string, Map<string, number>>();

  for (const order of saleOrders) {
    const partnerId = Array.isArray(order.partner_id)
      ? Number(order.partner_id[0])
      : 0;
    const area = partnerArea.get(partnerId) || 'Unknown area';
    const amount = Number(order.amount_total) || 0;
    areaTotals.set(area, (areaTotals.get(area) || 0) + amount);

    const orderDate = parseOdooDate(order.date_order);
    if (!orderDate) {
      continue;
    }
    const bucket =
      window.bucketMode === 'hour'
        ? yangonHourKey(orderDate)
        : yangonDateKey(orderDate);
    if (!areaSeriesMap.has(area)) {
      areaSeriesMap.set(area, new Map());
    }
    const series = areaSeriesMap.get(area)!;
    series.set(bucket, (series.get(bucket) || 0) + amount);
  }

  const topAreas = [...areaTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, total]) => ({ name, total }));

  const areaChart = {
    buckets: window.buckets,
    series: topAreas.map(area => ({
      name: area.name,
      total: area.total,
      points: window.buckets.map(bucket => ({
        bucket,
        value: areaSeriesMap.get(area.name)?.get(bucket) || 0,
      })),
    })),
  };

  // Product rankings from sale order lines
  const orderIds = saleOrders.map(order => order.id);
  const productTotals = new Map<
    string,
    { id: string; name: string; revenue: number; qty: number }
  >();
  let itemsSold = 0;

  if (orderIds.length > 0) {
    const chunkSize = 200;
    for (let i = 0; i < orderIds.length; i += chunkSize) {
      const chunk = orderIds.slice(i, i + chunkSize);
      let lines: OverviewLineRow[] = [];
      try {
        lines = await searchReadOdooRecords<OverviewLineRow>(
          session,
          'sale.order.line',
          [
            ['order_id', 'in', chunk],
            ['display_type', '=', false],
          ],
          [
            'id',
            'product_id',
            'price_subtotal',
            'product_uom_qty',
            'display_type',
          ],
          { limit: 2000 },
        );
      } catch {
        lines = await searchReadOdooRecords<OverviewLineRow>(
          session,
          'sale.order.line',
          [['order_id', 'in', chunk]],
          ['id', 'product_id', 'price_subtotal', 'product_uom_qty'],
          { limit: 2000 },
        );
      }

      for (const line of lines) {
        if (line.display_type) {
          continue;
        }
        const productId = Array.isArray(line.product_id)
          ? String(line.product_id[0])
          : '';
        const productName = Array.isArray(line.product_id)
          ? String(line.product_id[1] || '').trim()
          : '';
        const qty = Number(line.product_uom_qty) || 0;
        itemsSold += qty;
        if (!productId || !productName) {
          continue;
        }
        const existing = productTotals.get(productId) || {
          id: productId,
          name: productName,
          revenue: 0,
          qty: 0,
        };
        existing.revenue += Number(line.price_subtotal) || 0;
        existing.qty += qty;
        productTotals.set(productId, existing);
      }
    }
  }

  const rankedProducts = [...productTotals.values()].sort(
    (a, b) => b.revenue - a.revenue,
  );
  const topProducts = rankedProducts.slice(0, 3);
  const bottomProducts =
    rankedProducts.length <= 3
      ? []
      : [...rankedProducts].reverse().slice(0, 3);

  const demandRanked = [...productTotals.values()].sort(
    (a, b) => b.qty - a.qty,
  );
  const topDemandCandidates = demandRanked.slice(0, 3);

  const stockByProductId = new Map<number, number>();
  const demandProductIds = topDemandCandidates
    .map(row => Number(row.id))
    .filter(id => Number.isFinite(id) && id > 0);

  let lowestOnHandProducts: Array<{
    id: string;
    name: string;
    onHand: number;
  }> = [];
  let highestDemandProducts: Array<{
    id: string;
    name: string;
    demandQty: number;
    onHand: number;
    revenue: number;
  }> = [];

  try {
    // Lowest on-hand: sample stockable products and pick the 3 lowest qty.
    // qty_available is often non-stored, so we sort in memory.
    type StockProductRow = {
      id: number;
      name: string;
      qty_available?: number;
    };
    let stockRows: StockProductRow[] = [];
    try {
      stockRows = await searchReadOdooRecords<StockProductRow>(
        session,
        'product.product',
        [
          ['active', '=', true],
          ['sale_ok', '=', true],
          ['type', 'in', ['product', 'consu']],
        ],
        ['id', 'name', 'qty_available'],
        { limit: 400 },
      );
    } catch {
      stockRows = await searchReadOdooRecords<StockProductRow>(
        session,
        'product.product',
        [['active', '=', true], ['sale_ok', '=', true]],
        ['id', 'name', 'qty_available'],
        { limit: 400 },
      );
    }

    for (const row of stockRows) {
      stockByProductId.set(row.id, Number(row.qty_available) || 0);
    }

    lowestOnHandProducts = [...stockRows]
      .map(row => ({
        id: String(row.id),
        name: String(row.name || '').trim() || `Product #${row.id}`,
        onHand: Number(row.qty_available) || 0,
      }))
      .sort((a, b) => a.onHand - b.onHand)
      .slice(0, 3);

    // Fill any missing demand-product stock from a targeted read.
    const missingDemandIds = demandProductIds.filter(
      id => !stockByProductId.has(id),
    );
    if (missingDemandIds.length > 0) {
      const extra = await searchReadOdooRecords<StockProductRow>(
        session,
        'product.product',
        [['id', 'in', missingDemandIds]],
        ['id', 'name', 'qty_available'],
        { limit: missingDemandIds.length },
      );
      for (const row of extra) {
        stockByProductId.set(row.id, Number(row.qty_available) || 0);
      }
    }

    highestDemandProducts = topDemandCandidates.map(row => {
      const idNum = Number(row.id);
      return {
        id: row.id,
        name: row.name,
        demandQty: row.qty,
        onHand: stockByProductId.get(idNum) ?? 0,
        revenue: row.revenue,
      };
    });
  } catch (error) {
    console.warn(
      '[insights] Stock on-hand enrichment failed:',
      error instanceof Error ? error.message : error,
    );
    highestDemandProducts = topDemandCandidates.map(row => ({
      id: row.id,
      name: row.name,
      demandQty: row.qty,
      onHand: 0,
      revenue: row.revenue,
    }));
  }

  const recentOrders = saleOrders.slice(0, 8).map(order => ({
    id: String(order.id),
    number: String(order.name || ''),
    customer: Array.isArray(order.partner_id)
      ? String(order.partner_id[1] || '')
      : '',
    total: Number(order.amount_total) || 0,
    orderDate: String(order.date_order || ''),
    status: String(order.state || ''),
  }));

  const customerSpend = new Map<
    string,
    { id: string; name: string; total: number; orders: number }
  >();
  for (const order of saleOrders) {
    const id = Array.isArray(order.partner_id)
      ? String(order.partner_id[0] || '')
      : '';
    const name = Array.isArray(order.partner_id)
      ? String(order.partner_id[1] || '').trim()
      : '';
    if (!id) {
      continue;
    }
    const existing = customerSpend.get(id) || {
      id,
      name: name || 'Unknown customer',
      total: 0,
      orders: 0,
    };
    existing.total += Number(order.amount_total) || 0;
    existing.orders += 1;
    if (name) {
      existing.name = name;
    }
    customerSpend.set(id, existing);
  }

  const topSpendingCustomers = [...customerSpend.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  const recentPurchaseOrders = purchaseOrders.slice(0, 8).map(order => ({
    id: String(order.id),
    number: String(order.name || ''),
    vendor: Array.isArray(order.partner_id)
      ? String(order.partner_id[1] || '')
      : '',
    total: Number(order.amount_total) || 0,
    orderDate: String(order.date_order || ''),
    status: String(order.state || ''),
  }));

  return {
    period,
    range: {
      from: fromStr,
      to: toStr,
    },
    kpis: {
      saleAmount: {
        value: saleAmount,
        trend: trendPercent(saleAmount, prevSaleAmount),
      },
      confirmedOrders: {
        value: orderCount,
        trend: trendPercent(orderCount, prevOrderCount),
      },
      buyingCustomers: {
        value: buyingCustomerIds.size,
        trend: trendPercent(
          buyingCustomerIds.size,
          prevBuyingCustomerIds.size,
        ),
      },
      quotations: {
        value: Number(quotationCount) || 0,
        trend: trendPercent(
          Number(quotationCount) || 0,
          Number(prevQuotationCount) || 0,
        ),
      },
      itemsSold: {
        value: itemsSold,
        trend: 0,
      },
      avgOrderValue: {
        value: avgOrderValue,
        trend: trendPercent(avgOrderValue, prevAvg),
      },
      purchaseAmount: {
        value: purchaseAmount,
        trend: trendPercent(purchaseAmount, prevPurchaseAmount),
      },
      purchaseOrders: {
        value: purchaseOrderCount,
        trend: trendPercent(purchaseOrderCount, prevPurchaseOrderCount),
      },
      // Kept for older clients; same period window as quotations / buying customers.
      totalCustomers: {
        value: buyingCustomerIds.size,
        trend: trendPercent(
          buyingCustomerIds.size,
          prevBuyingCustomerIds.size,
        ),
      },
      openQuotations: {
        value: Number(quotationCount) || 0,
        trend: trendPercent(
          Number(quotationCount) || 0,
          Number(prevQuotationCount) || 0,
        ),
      },
      activeMemberships: {
        value: Number(membershipCount) || 0,
        trend: trendPercent(
          Number(membershipCount) || 0,
          Number(prevMembershipCount) || 0,
        ),
      },
    },
    areaChart,
    topProducts,
    bottomProducts,
    lowestOnHandProducts,
    highestDemandProducts,
    topSpendingCustomers,
    recentOrders,
    recentPurchaseOrders,
  };
}
