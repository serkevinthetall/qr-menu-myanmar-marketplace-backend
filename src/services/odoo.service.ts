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
  qty_available: number;
  active: boolean;
  categ_id: [number, string] | false;
  image_128: string | false;
  uom_id: [number, string] | false;
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
  const response = await fetch(`${env.odooUrl}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        db: env.odooDb,
        login,
        password,
      },
      id: Date.now(),
    }),
  });

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

export async function fetchOdooProducts(userId: string): Promise<OdooProduct[]> {
  const session = getOdooSession(userId);

  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

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
        args: [
          [],
          [
            'id',
            'name',
            'default_code',
            'list_price',
            'qty_available',
            'active',
            'categ_id',
            'image_128',
            'uom_id',
          ],
        ],
        kwargs: {
          order: 'name asc',
          limit: 500,
        },
      },
      id: Date.now(),
    }),
  });

  const data = (await response.json()) as JsonRpcResponse<OdooProduct[]>;

  if (data.error) {
    const message =
      data.error.data?.message ?? data.error.message ?? 'Failed to load products.';
    throw new Error(message);
  }

  return data.result ?? [];
}

export type OdooQuotation = {
  id: number;
  name: string;
  create_date: string | false;
  partner_id: [number, string] | false;
  amount_total: number;
  state: string;
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
  x_studio_preferred_delivery_date: string | false;
  x_studio_delivery_notes: string | false;
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
  'x_studio_phonenumber',
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

export type CreateQuotationLineInput = {
  productId: number;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
};

export type CreateQuotationInput = {
  partnerId: number;
  deliveryNotes?: string;
  preferredDeliveryDate?: string;
  phoneNumber?: string;
  lines: CreateQuotationLineInput[];
};

export async function createOdooQuotation(
  userId: string,
  input: CreateQuotationInput,
): Promise<{ id: number; name: string }> {
  const session = getOdooSession(userId);

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

  const values: Record<string, unknown> = {
    partner_id: input.partnerId,
    partner_invoice_id: input.partnerId,
    partner_shipping_id: input.partnerId,
    order_line: orderLineCommands,
  };

  const deliveryNotes = input.deliveryNotes?.trim();
  if (deliveryNotes) {
    values.x_studio_delivery_notes = deliveryNotes;
  }

  const preferredDeliveryDate = input.preferredDeliveryDate?.trim();
  if (preferredDeliveryDate) {
    values.x_studio_preferred_delivery_date = preferredDeliveryDate;
  }

  const phoneNumber = input.phoneNumber?.trim();
  if (phoneNumber) {
    values.x_studio_phonenumber = phoneNumber;
  }

  const quotationId = await createOdooRecord(session, 'sale.order', values);
  const created = await readOdooRecord<{ id: number; name: string }>(
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
): Promise<OdooQuotation[]> {
  const session = getOdooSession(userId);

  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

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
          limit: 1000,
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

  const detail = await readOdooRecord<OdooQuotationDetail>(
    session,
    'sale.order',
    quotationId,
    QUOTATION_DETAIL_FIELDS,
  );

  if (detail) {
    return detail;
  }

  const summary = await readOdooRecord<OdooQuotationDetail>(
    session,
    'sale.order',
    quotationId,
    QUOTATION_LIST_FIELDS,
  );

  return summary;
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
  if (phone) {
    const existing = await searchOdooContactsByPhone(userId, phone);
    if (existing.length > 0) {
      throw new Error(
        'A contact with this phone number already exists. Open the existing contact instead of creating a new one.',
      );
    }
  }

  const values: Record<string, unknown> = {
    name,
    customer_rank: 1,
  };

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
): Promise<{ formatted: string; phone: string }> {
  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    return { formatted: '', phone: '' };
  }

  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const partner = await readOdooRecord<OdooPartnerAddress>(
    session,
    'res.partner',
    partnerId,
    PARTNER_ADDRESS_FIELDS,
  );

  if (!partner) {
    return { formatted: '', phone: '' };
  }

  const township = await fetchOdooTownshipForPartner(userId, partner);
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

  return searchReadOdooRecords<OdooOrderLine>(
    session,
    'sale.order.line',
    [['order_id', '=', quotationId]],
    ORDER_LINE_FIELDS,
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
        model: 'res.partner',
        method: 'search_read',
        args: [[], fields],
        kwargs: {
          order: 'name asc',
          limit: 1000,
        },
      },
      id: Date.now(),
    }),
  });

  const data = (await response.json()) as JsonRpcResponse<OdooContact[]>;

  if (data.error) {
    const message =
      data.error.data?.message ?? data.error.message ?? 'Failed to load contacts.';
    throw new Error(message);
  }

  return data.result ?? [];
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
