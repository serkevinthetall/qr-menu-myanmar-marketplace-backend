import { getOdooSession } from './odoo-session.store.js';
import { callOdooKwForUser } from './odoo.service.js';
import {
  toNumberValue,
  toRelationId,
  toRelationName,
  toStringValue,
} from '../utils/quotation-mapper.js';

const SALE_ORDER_MODEL = 'sale.order';

export type ChatterMessage = {
  id: string;
  body: string;
  date: string;
  author: string;
  messageType: string;
  isNote: boolean;
  subject: string;
};

export type ChatterActivity = {
  id: string;
  summary: string;
  note: string;
  deadline: string;
  state: string;
  activityType: string;
  activityTypeId: string;
  assignedTo: string;
  createDate: string;
};

export type ChatterActivityType = {
  id: string;
  name: string;
};

export type ChatterPayload = {
  messages: ChatterMessage[];
  activities: ChatterActivity[];
  activityTypes: ChatterActivityType[];
};

type OdooMailMessage = {
  id: number;
  body?: string | false;
  date?: string | false;
  author_id?: [number, string] | false;
  message_type?: string | false;
  subtype_id?: [number, string] | false;
  subject?: string | false;
  is_internal?: boolean;
};

type OdooMailActivity = {
  id: number;
  summary?: string | false;
  note?: string | false;
  date_deadline?: string | false;
  state?: string | false;
  activity_type_id?: [number, string] | false;
  user_id?: [number, string] | false;
  create_date?: string | false;
};

type OdooActivityType = {
  id: number;
  name?: string | false;
};

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toHtmlBody(plain: string): string {
  const safe = escapeHtml(plain.trim()).replace(/\n/g, '<br/>');
  return `<p>${safe}</p>`;
}

function isInternalNote(row: OdooMailMessage): boolean {
  if (row.is_internal === true) return true;
  const subtype = toRelationName(row.subtype_id).toLowerCase();
  return subtype.includes('note');
}

async function assertSaleOrderExists(userId: string, orderId: number) {
  const rows = await callOdooKwForUser<{ id: number }[]>(
    userId,
    SALE_ORDER_MODEL,
    'search_read',
    [[['id', '=', orderId]]],
    { fields: ['id'], limit: 1 },
  );
  if (!rows.length) {
    throw new Error('Sale order not found.');
  }
}

function mapMessage(row: OdooMailMessage): ChatterMessage {
  return {
    id: String(row.id),
    body: stripHtml(toStringValue(row.body)),
    date: toStringValue(row.date),
    author: toRelationName(row.author_id) || 'System',
    messageType: toStringValue(row.message_type) || 'notification',
    isNote: isInternalNote(row),
    subject: toStringValue(row.subject),
  };
}

function mapActivity(row: OdooMailActivity): ChatterActivity {
  return {
    id: String(row.id),
    summary: toStringValue(row.summary),
    note: stripHtml(toStringValue(row.note)),
    deadline: toStringValue(row.date_deadline),
    state: toStringValue(row.state),
    activityType: toRelationName(row.activity_type_id),
    activityTypeId: String(toRelationId(row.activity_type_id) || ''),
    assignedTo: toRelationName(row.user_id),
    createDate: toStringValue(row.create_date),
  };
}

export async function fetchSaleOrderChatter(
  userId: string,
  orderId: number,
): Promise<ChatterPayload> {
  await assertSaleOrderExists(userId, orderId);

  const [messages, activities, activityTypes] = await Promise.all([
    callOdooKwForUser<OdooMailMessage[]>(
      userId,
      'mail.message',
      'search_read',
      [
        [
          ['model', '=', SALE_ORDER_MODEL],
          ['res_id', '=', orderId],
          ['message_type', '!=', 'user_notification'],
        ],
      ],
      {
        fields: [
          'id',
          'body',
          'date',
          'author_id',
          'message_type',
          'subtype_id',
          'subject',
          'is_internal',
        ],
        order: 'date desc, id desc',
        limit: 80,
      },
    ),
    callOdooKwForUser<OdooMailActivity[]>(
      userId,
      'mail.activity',
      'search_read',
      [
        [
          ['res_model', '=', SALE_ORDER_MODEL],
          ['res_id', '=', orderId],
        ],
      ],
      {
        fields: [
          'id',
          'summary',
          'note',
          'date_deadline',
          'state',
          'activity_type_id',
          'user_id',
          'create_date',
        ],
        order: 'date_deadline asc, id asc',
        limit: 40,
      },
    ),
    callOdooKwForUser<OdooActivityType[]>(
      userId,
      'mail.activity.type',
      'search_read',
      [
        [
          '|',
          ['res_model', '=', false],
          ['res_model', '=', SALE_ORDER_MODEL],
        ],
      ],
      {
        fields: ['id', 'name'],
        order: 'sequence asc, id asc',
        limit: 40,
      },
    ).catch(async () => {
      // Some DBs restrict res_model domain; fall back to common types.
      return callOdooKwForUser<OdooActivityType[]>(
        userId,
        'mail.activity.type',
        'search_read',
        [[]],
        {
          fields: ['id', 'name'],
          order: 'sequence asc, id asc',
          limit: 40,
        },
      );
    }),
  ]);

  return {
    messages: messages.map(mapMessage).filter(m => m.body || m.subject),
    activities: activities.map(mapActivity),
    activityTypes: activityTypes.map(row => ({
      id: String(row.id),
      name: toStringValue(row.name) || `Type ${row.id}`,
    })),
  };
}

export async function postSaleOrderChatterNote(
  userId: string,
  orderId: number,
  body: string,
): Promise<ChatterPayload> {
  const text = body.trim();
  if (!text) {
    throw new Error('Note cannot be empty.');
  }
  await assertSaleOrderExists(userId, orderId);

  await callOdooKwForUser(userId, SALE_ORDER_MODEL, 'message_post', [[orderId]], {
    body: toHtmlBody(text),
    message_type: 'comment',
    subtype_xmlid: 'mail.mt_note',
  });

  return fetchSaleOrderChatter(userId, orderId);
}

export async function postSaleOrderChatterMessage(
  userId: string,
  orderId: number,
  body: string,
): Promise<ChatterPayload> {
  const text = body.trim();
  if (!text) {
    throw new Error('Message cannot be empty.');
  }
  await assertSaleOrderExists(userId, orderId);

  await callOdooKwForUser(userId, SALE_ORDER_MODEL, 'message_post', [[orderId]], {
    body: toHtmlBody(text),
    message_type: 'comment',
    subtype_xmlid: 'mail.mt_comment',
  });

  return fetchSaleOrderChatter(userId, orderId);
}

export async function scheduleSaleOrderActivity(
  userId: string,
  orderId: number,
  input: {
    summary?: string;
    note?: string;
    deadline?: string;
    activityTypeId?: number;
  },
): Promise<ChatterPayload> {
  await assertSaleOrderExists(userId, orderId);

  const session = getOdooSession(userId);
  if (!session) {
    throw new Error('Odoo session expired. Please log in again.');
  }

  let activityTypeId = input.activityTypeId;
  if (!activityTypeId || !Number.isFinite(activityTypeId) || activityTypeId <= 0) {
    const types = await callOdooKwForUser<OdooActivityType[]>(
      userId,
      'mail.activity.type',
      'search_read',
      [[]],
      { fields: ['id', 'name'], order: 'sequence asc, id asc', limit: 1 },
    );
    activityTypeId = types[0]?.id;
  }
  if (!activityTypeId) {
    throw new Error('No activity type available in Odoo.');
  }

  const deadline =
    input.deadline?.trim() ||
    new Date().toISOString().slice(0, 10);

  const values: Record<string, unknown> = {
    res_model: SALE_ORDER_MODEL,
    res_id: orderId,
    activity_type_id: activityTypeId,
    user_id: session.uid,
    date_deadline: deadline,
  };

  const summary = input.summary?.trim();
  if (summary) values.summary = summary;

  const note = input.note?.trim();
  if (note) values.note = toHtmlBody(note);

  await callOdooKwForUser(userId, 'mail.activity', 'create', [values]);
  return fetchSaleOrderChatter(userId, orderId);
}

export async function markSaleOrderActivityDone(
  userId: string,
  orderId: number,
  activityId: number,
  feedback?: string,
): Promise<ChatterPayload> {
  await assertSaleOrderExists(userId, orderId);

  const note = feedback?.trim();
  try {
    await callOdooKwForUser(
      userId,
      'mail.activity',
      'action_feedback',
      [[activityId]],
      note ? { feedback: note } : {},
    );
  } catch {
    // Older / restricted DBs may only expose action_done.
    await callOdooKwForUser(userId, 'mail.activity', 'action_done', [
      [activityId],
    ]);
  }

  return fetchSaleOrderChatter(userId, orderId);
}

export async function cancelSaleOrderActivity(
  userId: string,
  orderId: number,
  activityId: number,
): Promise<ChatterPayload> {
  await assertSaleOrderExists(userId, orderId);

  try {
    await callOdooKwForUser(userId, 'mail.activity', 'unlink', [[activityId]]);
  } catch {
    await callOdooKwForUser(userId, 'mail.activity', 'action_cancel', [
      [activityId],
    ]);
  }

  return fetchSaleOrderChatter(userId, orderId);
}

/** Parse positive integer id from route/body; returns 0 if invalid. */
export function parsePositiveId(value: unknown): number {
  const n = toNumberValue(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}
