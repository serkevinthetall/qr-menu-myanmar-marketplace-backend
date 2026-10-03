import { Router } from 'express';

import { authMiddleware } from '../middleware/auth.js';
import {
  clearPendingAppOrderIds,
  countPendingUnreadAppOrders,
  isAppOrderNotifyActive,
  listAppOrderNotifyEventsSince,
  seedPendingAppOrderIds,
  waitForAppOrderNotifyEvents,
} from '../services/app-order-notify.store.js';
import {
  listReadAppOrderIds,
  setAppOrderRead,
  setAppOrderReadMany,
} from '../services/app-order-read.store.js';
import {
  createOdooSaleOrderInvoice,
  enrichSaleOrderActionFlags,
  fetchOdooDeliveryPreviewsForOrder,
  fetchOdooInvoicePreviewsForOrder,
  fetchOdooOnlineOrderDetailBundle,
  fetchOdooOnlineOrders,
  fetchSaleOrderIdsWithValidatableDelivery,
  payOdooSaleOrderInvoice,
  validateOdooSaleOrderDelivery,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';
import {
  mapSaleOrderDetail,
  mapSaleOrderSummary,
} from '../utils/sale-order-mapper.js';
import { mountSaleOrderChatterRoutes } from './sale-order-chatter.routes.js';

const router = Router();

router.use(authMiddleware);

mountSaleOrderChatterRoutes(router, {
  logLabel: 'online-orders',
  idLabel: 'app order',
});

function mapNotifyFeedResponse(
  feed: Awaited<ReturnType<typeof listAppOrderNotifyEventsSince>>,
  unreadCount: number,
) {
  return {
    revision: feed.revision,
    active: feed.active,
    events: feed.events.map(event => ({
      revision: event.revision,
      id: String(event.id),
      number: event.number,
      customer: event.customer,
      total: event.total,
      at: event.at,
    })),
    unreadCount,
  };
}

/**
 * Cheap Redis/file feed for website alerts — no Odoo call.
 * GET /api/online-orders/notify-feed?since=<revision>
 */
router.get('/notify-feed', async (req: AuthRequest, res) => {
  try {
    const since = Number(req.query.since);
    const feed = await listAppOrderNotifyEventsSince(
      Number.isFinite(since) ? since : 0,
    );
    const readIds = await listReadAppOrderIds();
    const unreadCount = await countPendingUnreadAppOrders(readIds);
    return res.json({
      data: mapNotifyFeedResponse(feed, unreadCount),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load notify feed.';
    console.error('[online-orders] notify-feed', message);
    return res.status(500).json({ message });
  }
});

/**
 * Long-poll: hold until Redis revision advances (Odoo webhook) or timeout.
 * Website keeps one open request — not a busy Odoo loop.
 * GET /api/online-orders/notify-wait?since=<revision>&timeout=8000
 */
router.get('/notify-wait', async (req: AuthRequest, res) => {
  try {
    const since = Number(req.query.since);
    const timeoutRaw = Number(req.query.timeout);
    const timeoutMs =
      Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? Math.min(timeoutRaw, 20_000)
        : 8_000;
    const feed = await waitForAppOrderNotifyEvents(
      Number.isFinite(since) ? since : 0,
      timeoutMs,
    );
    const readIds = await listReadAppOrderIds();
    const unreadCount = await countPendingUnreadAppOrders(readIds);
    return res.json({
      data: mapNotifyFeedResponse(feed, unreadCount),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to wait for notify.';
    console.error('[online-orders] notify-wait', message);
    return res.status(500).json({ message });
  }
});

router.get('/unread-count', async (req: AuthRequest, res) => {
  try {
    const readIds = await listReadAppOrderIds();
    if (await isAppOrderNotifyActive()) {
      const unreadCount = await countPendingUnreadAppOrders(readIds);
      return res.json({ data: { unreadCount, source: 'notify' } });
    }

    const rows = await fetchOdooOnlineOrders(req.user!.id, {
      limit: 500,
      offset: 0,
    });
    const unreadIds = rows
      .filter(row => !readIds.has(row.id))
      .map(row => row.id);
    await seedPendingAppOrderIds(unreadIds);
    return res.json({
      data: { unreadCount: unreadIds.length, source: 'odoo' },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load unread count.';
    console.error('[online-orders] unread-count', message);
    return res.status(500).json({ message });
  }
});

router.get('/', async (req: AuthRequest, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const q = String(req.query.q ?? '').trim();
    const from = String(req.query.from ?? '').trim();
    const to = String(req.query.to ?? '').trim();
    const readFilterRaw = String(req.query.read ?? '').trim().toLowerCase();
    const readFilter =
      readFilterRaw === 'read' || readFilterRaw === 'unread'
        ? readFilterRaw
        : undefined;

    const rows = await fetchOdooOnlineOrders(req.user!.id, {
      limit,
      offset,
      q: q || undefined,
      from: from || undefined,
      to: to || undefined,
    });
    const readIds = await listReadAppOrderIds();
    const unreadIds = rows
      .filter(row => !readIds.has(row.id))
      .map(row => row.id);
    // Hydrate webhook pending set so badges stay cheap after list loads.
    void seedPendingAppOrderIds(unreadIds).catch(() => undefined);
    // Opt-in: stock.picking enrichment is slow (~seconds). Only when list
    // selection / bulk validate is enabled (includeValidate=1).
    const includeValidateRaw = String(req.query.includeValidate ?? '')
      .trim()
      .toLowerCase();
    const includeValidate =
      includeValidateRaw === '1' || includeValidateRaw === 'true';
    const validatableIds = includeValidate
      ? await fetchSaleOrderIdsWithValidatableDelivery(
          req.user!.id,
          rows.map(row => row.id),
        )
      : new Set<number>();

    let data = rows.map(row => {
      const summary = mapSaleOrderSummary(row);
      const unread = !readIds.has(row.id);
      return {
        ...summary,
        unread,
        canValidateDelivery: validatableIds.has(row.id),
      };
    });

    if (readFilter === 'read') {
      data = data.filter(row => !row.unread);
    } else if (readFilter === 'unread') {
      data = data.filter(row => row.unread);
    }

    const unreadCount = rows.reduce(
      (count, row) => count + (readIds.has(row.id) ? 0 : 1),
      0,
    );

    return res.json({
      data,
      meta: {
        limit,
        offset,
        count: data.length,
        hasMore: data.length >= limit,
        unreadCount,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load app orders.';
    console.error('[online-orders]', message);
    return res.status(500).json({ message });
  }
});

router.put('/read-all', async (req: AuthRequest, res) => {
  const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids = rawIds
    .map((value: unknown) => Number(value))
    .filter((id: number) => Number.isFinite(id) && id > 0);

  const read = req.body?.read === undefined ? true : Boolean(req.body.read);

  try {
    // Empty ids → mark every currently loaded App Order window as read/unread.
    let targetIds = ids;
    if (targetIds.length === 0) {
      const rows = await fetchOdooOnlineOrders(req.user!.id, {
        limit: 500,
        offset: 0,
      });
      targetIds = rows.map(row => row.id);
    }

    await setAppOrderReadMany(targetIds, read);
    if (read) {
      await clearPendingAppOrderIds(targetIds);
    } else {
      await seedPendingAppOrderIds(targetIds);
    }
    const readIds = await listReadAppOrderIds();
    const unreadCount = await countPendingUnreadAppOrders(readIds);

    return res.json({
      data: {
        updated: targetIds.length,
        read,
        unreadCount,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to update read state.';
    console.error('[online-orders] read-all', message);
    return res.status(500).json({ message });
  }
});

router.put('/:id/read', async (req: AuthRequest, res) => {
  const saleOrderId = Number(req.params.id);
  if (!Number.isFinite(saleOrderId) || saleOrderId <= 0) {
    return res.status(400).json({ message: 'Invalid app order id.' });
  }

  const read = Boolean(req.body?.read);
  try {
    // Ensure order is a valid App Order before mutating shared state.
    const bundle = await fetchOdooOnlineOrderDetailBundle(
      req.user!.id,
      saleOrderId,
    );
    if (!bundle) {
      return res.status(404).json({ message: 'App order not found.' });
    }

    await setAppOrderRead(saleOrderId, read);
    if (read) {
      await clearPendingAppOrderIds([saleOrderId]);
    } else {
      await seedPendingAppOrderIds([saleOrderId]);
    }
    return res.json({
      data: { id: String(saleOrderId), unread: !read },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to update read state.';
    console.error('[online-orders] read', message);
    return res.status(500).json({ message });
  }
});

router.get('/:id', async (req: AuthRequest, res) => {
  const saleOrderId = Number(req.params.id);
  if (!Number.isFinite(saleOrderId) || saleOrderId <= 0) {
    return res.status(400).json({ message: 'Invalid app order id.' });
  }

  try {
    const bundle = await fetchOdooOnlineOrderDetailBundle(
      req.user!.id,
      saleOrderId,
    );
    if (!bundle) {
      return res.status(404).json({ message: 'App order not found.' });
    }

    // Opening detail marks the order read for the whole team.
    await setAppOrderRead(saleOrderId, true);
    await clearPendingAppOrderIds([saleOrderId]);
    const detail = mapSaleOrderDetail(bundle);
    const flags = await enrichSaleOrderActionFlags(
      req.user!.id,
      saleOrderId,
      bundle.saleOrder,
    );

    return res.json({
      data: {
        ...detail,
        unread: false,
        canValidateDelivery: flags.canValidateDelivery,
        deliveryCount: flags.deliveryCount,
        invoiceCount: flags.invoiceCount,
        canCreateInvoice: flags.canCreateInvoice,
        canPayInvoice: flags.canPayInvoice,
        payableInvoice: flags.payableInvoice,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load app order.';
    console.error('[online-orders]', message);
    return res.status(500).json({ message });
  }
});

router.get('/:id/deliveries', async (req: AuthRequest, res) => {
  const saleOrderId = Number(req.params.id);
  if (!Number.isFinite(saleOrderId) || saleOrderId <= 0) {
    return res.status(400).json({ message: 'Invalid app order id.' });
  }

  try {
    const bundle = await fetchOdooOnlineOrderDetailBundle(
      req.user!.id,
      saleOrderId,
    );
    if (!bundle) {
      return res.status(404).json({ message: 'App order not found.' });
    }

    const data = await fetchOdooDeliveryPreviewsForOrder(
      req.user!.id,
      saleOrderId,
    );
    return res.json({ data });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to load delivery preview.';
    console.error('[online-orders] deliveries', message);
    return res.status(500).json({ message });
  }
});

router.get('/:id/invoices', async (req: AuthRequest, res) => {
  const saleOrderId = Number(req.params.id);
  if (!Number.isFinite(saleOrderId) || saleOrderId <= 0) {
    return res.status(400).json({ message: 'Invalid app order id.' });
  }

  try {
    const bundle = await fetchOdooOnlineOrderDetailBundle(
      req.user!.id,
      saleOrderId,
    );
    if (!bundle) {
      return res.status(404).json({ message: 'App order not found.' });
    }

    const data = await fetchOdooInvoicePreviewsForOrder(
      req.user!.id,
      saleOrderId,
    );
    return res.json({ data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load invoices.';
    console.error('[online-orders] invoices', message);
    return res.status(500).json({ message });
  }
});

router.post('/:id/validate-delivery', async (req: AuthRequest, res) => {
  const saleOrderId = Number(req.params.id);
  if (!Number.isFinite(saleOrderId) || saleOrderId <= 0) {
    return res.status(400).json({ message: 'Invalid app order id.' });
  }

  try {
    const bundle = await fetchOdooOnlineOrderDetailBundle(
      req.user!.id,
      saleOrderId,
    );
    if (!bundle) {
      return res.status(404).json({ message: 'App order not found.' });
    }

    const pickingIdRaw = Number(
      (req.body as { pickingId?: string | number } | undefined)?.pickingId,
    );
    const pickingId =
      Number.isFinite(pickingIdRaw) && pickingIdRaw > 0
        ? pickingIdRaw
        : undefined;
    const result = await validateOdooSaleOrderDelivery(
      req.user!.id,
      saleOrderId,
      pickingId ? { pickingId } : undefined,
    );
    const flags = await enrichSaleOrderActionFlags(
      req.user!.id,
      saleOrderId,
      result.saleOrder,
    );
    return res.json({
      data: {
        ...mapSaleOrderDetail(result),
        unread: false,
        canValidateDelivery: flags.canValidateDelivery,
        deliveryCount: flags.deliveryCount,
        invoiceCount: flags.invoiceCount,
        canCreateInvoice: flags.canCreateInvoice,
        canPayInvoice: flags.canPayInvoice,
        payableInvoice: flags.payableInvoice,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to validate delivery.';
    const status =
      /already validated|no delivery is ready|only confirmed sales orders/i.test(
        message,
      )
        ? 409
        : /not found/i.test(message)
          ? 404
          : 500;
    console.error('[online-orders] validate-delivery', message);
    return res.status(status).json({ message });
  }
});

router.post('/:id/create-invoice', async (req: AuthRequest, res) => {
  const saleOrderId = Number(req.params.id);
  if (!Number.isFinite(saleOrderId) || saleOrderId <= 0) {
    return res.status(400).json({ message: 'Invalid app order id.' });
  }

  try {
    const bundle = await fetchOdooOnlineOrderDetailBundle(
      req.user!.id,
      saleOrderId,
    );
    if (!bundle) {
      return res.status(404).json({ message: 'App order not found.' });
    }

    const result = await createOdooSaleOrderInvoice(req.user!.id, saleOrderId);
    const flags = await enrichSaleOrderActionFlags(
      req.user!.id,
      saleOrderId,
      result.saleOrder,
    );
    return res.json({
      data: {
        ...mapSaleOrderDetail(result),
        unread: false,
        canValidateDelivery: flags.canValidateDelivery,
        deliveryCount: flags.deliveryCount,
        invoiceCount: flags.invoiceCount,
        canCreateInvoice: flags.canCreateInvoice,
        canPayInvoice: flags.canPayInvoice,
        payableInvoice: flags.payableInvoice,
        invoiceName: result.invoiceName,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create invoice.';
    const status =
      /already fully invoiced|not ready to invoice|nothing to invoice|only confirmed sales orders/i.test(
        message,
      )
        ? 409
        : /not found/i.test(message)
          ? 404
          : 500;
    console.error('[online-orders] create-invoice', message);
    return res.status(status).json({ message });
  }
});

router.post('/:id/pay', async (req: AuthRequest, res) => {
  const saleOrderId = Number(req.params.id);
  if (!Number.isFinite(saleOrderId) || saleOrderId <= 0) {
    return res.status(400).json({ message: 'Invalid app order id.' });
  }

  const paymentMethodLineIdRaw = Number(
    (req.body as { paymentMethodLineId?: unknown })?.paymentMethodLineId,
  );
  const paymentMethodLineId =
    Number.isFinite(paymentMethodLineIdRaw) && paymentMethodLineIdRaw > 0
      ? paymentMethodLineIdRaw
      : undefined;

  try {
    const bundle = await fetchOdooOnlineOrderDetailBundle(
      req.user!.id,
      saleOrderId,
    );
    if (!bundle) {
      return res.status(404).json({ message: 'App order not found.' });
    }

    const result = await payOdooSaleOrderInvoice(req.user!.id, saleOrderId, {
      paymentMethodLineId,
    });
    const flags = await enrichSaleOrderActionFlags(
      req.user!.id,
      saleOrderId,
      result.saleOrder,
    );
    return res.json({
      data: {
        ...mapSaleOrderDetail(result),
        unread: false,
        canValidateDelivery: flags.canValidateDelivery,
        deliveryCount: flags.deliveryCount,
        invoiceCount: flags.invoiceCount,
        canCreateInvoice: flags.canCreateInvoice,
        canPayInvoice: flags.canPayInvoice,
        payableInvoice: flags.payableInvoice,
        invoiceName: result.invoiceName,
        paymentLabel: result.paymentLabel,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to register payment.';
    const status =
      /no unpaid invoice|only confirmed sales orders/i.test(message)
        ? 409
        : /not found/i.test(message)
          ? 404
          : 500;
    console.error('[online-orders] pay', message);
    return res.status(status).json({ message });
  }
});

export default router;
