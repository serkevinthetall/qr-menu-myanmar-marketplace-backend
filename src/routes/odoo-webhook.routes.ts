import { Router } from 'express';

import { env } from '../config/env.js';
import { recordAppOrderNotifyEvent } from '../services/app-order-notify.store.js';
import { listReadAppOrderIds } from '../services/app-order-read.store.js';

const router = Router();

function webhookSecretOk(req: {
  header: (name: string) => string | undefined;
  query: Record<string, unknown>;
}): boolean {
  const expected = env.odooWebhookSecret;
  if (!expected) return false;
  const header =
    req.header('x-odoo-webhook-secret') ||
    req.header('x-webhook-secret') ||
    '';
  const auth = req.header('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ')
    ? auth.slice(7).trim()
    : '';
  const querySecret = String(req.query.secret ?? '').trim();
  return header === expected || bearer === expected || querySecret === expected;
}

function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) {
      const n = Number(value[0]);
      if (Number.isFinite(n) && n > 0) return Math.trunc(n);
    }
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return 0;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (Array.isArray(value) && typeof value[1] === 'string') {
      return value[1];
    }
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return '';
}

/**
 * Odoo Automation / Server Action → website notify bus.
 *
 * POST /api/odoo/webhook/app-order
 * Header: X-Odoo-Webhook-Secret: <ODOO_WEBHOOK_SECRET>
 *
 * Accepts flexible payloads, e.g.:
 *   { "id": 123, "name": "S05202", "partner_id": [1,"Acme"], "amount_total": 1000, "state": "sent" }
 *   { "_id": 123, ... }  (some Odoo webhook shapes)
 */
router.post('/webhook/app-order', async (req, res) => {
  if (!env.odooWebhookSecret) {
    return res.status(503).json({
      message: 'ODOO_WEBHOOK_SECRET is not configured on the backend.',
    });
  }
  if (!webhookSecretOk(req)) {
    return res.status(401).json({ message: 'Invalid webhook secret.' });
  }

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const record =
      body.record && typeof body.record === 'object'
        ? (body.record as Record<string, unknown>)
        : body;

    const id = firstNumber(
      record.id,
      record._id,
      body.id,
      body._id,
      body.res_id,
    );
    if (!id) {
      return res.status(400).json({ message: 'Missing sale.order id.' });
    }

    // Trust Odoo Automated Action domain (App Orders only). Secret is the gate.
    const readIds = await listReadAppOrderIds();
    if (readIds.has(id)) {
      // Already read by the team — keep pending clear, no alert.
      return res.json({ data: { accepted: true, id, skipped: 'already_read' } });
    }

    const event = await recordAppOrderNotifyEvent({
      id,
      number: firstString(record.name, body.name, record.display_name),
      customer: firstString(
        record.partner_id,
        body.partner_id,
        record.partner_name,
        body.partner_name,
      ),
      total: Number(record.amount_total ?? body.amount_total) || 0,
      alert: true,
    });

    return res.json({
      data: {
        accepted: true,
        id,
        revision: event?.revision ?? null,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Webhook handling failed.';
    console.error('[odoo-webhook] app-order', message);
    return res.status(500).json({ message });
  }
});

router.get('/webhook/health', (_req, res) => {
  res.json({
    status: 'ok',
    webhookConfigured: Boolean(env.odooWebhookSecret),
  });
});

export default router;
