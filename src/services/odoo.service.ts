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
            'active',
            'categ_id',
            'uom_id',
          ],
        ],
        kwargs: {
          order: 'name asc',
          // Avoid image_128 (huge payload) and qty_available (slow computed field).
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
  preferred_payment_method_line_id?: [number, string] | false;
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
  'preferred_payment_method_line_id',
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

/** Lean contact list for New Quotation — fewer fields, customers only. */
export async function fetchOdooContactsForQuotation(
  userId: string,
): Promise<OdooContact[]> {
  const session = getOdooSession(userId);

  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  const fields = [...CONTACT_BASE_FIELDS, PARTNER_TOWNSHIP_FIELD];

  return searchReadOdooRecords<OdooContact>(
    session,
    'res.partner',
    [['customer_rank', '>', 0]],
    fields,
    {
      order: 'name asc',
      limit: 500,
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
