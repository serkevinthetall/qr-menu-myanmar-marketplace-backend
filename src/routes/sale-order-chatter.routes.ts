import { Router, Response } from 'express';

import {
  cancelSaleOrderActivity,
  fetchSaleOrderChatter,
  markSaleOrderActivityDone,
  parsePositiveId,
  postSaleOrderChatterMessage,
  postSaleOrderChatterNote,
  scheduleSaleOrderActivity,
} from '../services/odoo-chatter.service.js';
import { AuthRequest } from '../types/auth.js';

type MountOptions = {
  /** Log prefix e.g. quotations | sale-orders | online-orders */
  logLabel: string;
  /** Error label when id invalid */
  idLabel?: string;
};

function statusForChatterError(message: string): number {
  if (/not found/i.test(message)) return 404;
  if (/empty|invalid|required|cannot be empty|no activity type/i.test(message)) {
    return 400;
  }
  if (/session expired/i.test(message)) return 401;
  return 500;
}

/**
 * Mount Odoo chatter endpoints on a sale.order-backed router:
 *   GET    /:id/chatter
 *   POST   /:id/chatter/note
 *   POST   /:id/chatter/message
 *   POST   /:id/chatter/activity
 *   POST   /:id/chatter/activity/:activityId/done
 *   POST   /:id/chatter/activity/:activityId/cancel
 */
export function mountSaleOrderChatterRoutes(
  router: Router,
  options: MountOptions,
) {
  const idLabel = options.idLabel ?? 'order';
  const log = options.logLabel;

  router.get('/:id/chatter', async (req: AuthRequest, res: Response) => {
    const orderId = parsePositiveId(req.params.id);
    if (!orderId) {
      return res.status(400).json({ message: `Invalid ${idLabel} id.` });
    }
    try {
      const data = await fetchSaleOrderChatter(req.user!.id, orderId);
      return res.json({ data });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load chatter.';
      console.error(`[${log}] chatter`, message);
      return res.status(statusForChatterError(message)).json({ message });
    }
  });

  router.post('/:id/chatter/note', async (req: AuthRequest, res: Response) => {
    const orderId = parsePositiveId(req.params.id);
    if (!orderId) {
      return res.status(400).json({ message: `Invalid ${idLabel} id.` });
    }
    const body = String(
      (req.body as { body?: unknown } | undefined)?.body ?? '',
    );
    try {
      const data = await postSaleOrderChatterNote(req.user!.id, orderId, body);
      return res.json({ data });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to log note.';
      console.error(`[${log}] chatter note`, message);
      return res.status(statusForChatterError(message)).json({ message });
    }
  });

  router.post('/:id/chatter/message', async (req: AuthRequest, res: Response) => {
    const orderId = parsePositiveId(req.params.id);
    if (!orderId) {
      return res.status(400).json({ message: `Invalid ${idLabel} id.` });
    }
    const body = String(
      (req.body as { body?: unknown } | undefined)?.body ?? '',
    );
    try {
      const data = await postSaleOrderChatterMessage(
        req.user!.id,
        orderId,
        body,
      );
      return res.json({ data });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to send message.';
      console.error(`[${log}] chatter message`, message);
      return res.status(statusForChatterError(message)).json({ message });
    }
  });

  router.post(
    '/:id/chatter/activity',
    async (req: AuthRequest, res: Response) => {
      const orderId = parsePositiveId(req.params.id);
      if (!orderId) {
        return res.status(400).json({ message: `Invalid ${idLabel} id.` });
      }
      const payload = (req.body ?? {}) as {
        summary?: unknown;
        note?: unknown;
        deadline?: unknown;
        activityTypeId?: unknown;
      };
      try {
        const data = await scheduleSaleOrderActivity(req.user!.id, orderId, {
          summary: payload.summary != null ? String(payload.summary) : undefined,
          note: payload.note != null ? String(payload.note) : undefined,
          deadline:
            payload.deadline != null ? String(payload.deadline) : undefined,
          activityTypeId: parsePositiveId(payload.activityTypeId) || undefined,
        });
        return res.json({ data });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to schedule activity.';
        console.error(`[${log}] chatter activity`, message);
        return res.status(statusForChatterError(message)).json({ message });
      }
    },
  );

  router.post(
    '/:id/chatter/activity/:activityId/done',
    async (req: AuthRequest, res: Response) => {
      const orderId = parsePositiveId(req.params.id);
      const activityId = parsePositiveId(req.params.activityId);
      if (!orderId) {
        return res.status(400).json({ message: `Invalid ${idLabel} id.` });
      }
      if (!activityId) {
        return res.status(400).json({ message: 'Invalid activity id.' });
      }
      const feedback = String(
        (req.body as { feedback?: unknown } | undefined)?.feedback ?? '',
      );
      try {
        const data = await markSaleOrderActivityDone(
          req.user!.id,
          orderId,
          activityId,
          feedback || undefined,
        );
        return res.json({ data });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to mark activity done.';
        console.error(`[${log}] chatter activity done`, message);
        return res.status(statusForChatterError(message)).json({ message });
      }
    },
  );

  router.post(
    '/:id/chatter/activity/:activityId/cancel',
    async (req: AuthRequest, res: Response) => {
      const orderId = parsePositiveId(req.params.id);
      const activityId = parsePositiveId(req.params.activityId);
      if (!orderId) {
        return res.status(400).json({ message: `Invalid ${idLabel} id.` });
      }
      if (!activityId) {
        return res.status(400).json({ message: 'Invalid activity id.' });
      }
      try {
        const data = await cancelSaleOrderActivity(
          req.user!.id,
          orderId,
          activityId,
        );
        return res.json({ data });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to cancel activity.';
        console.error(`[${log}] chatter activity cancel`, message);
        return res.status(statusForChatterError(message)).json({ message });
      }
    },
  );
}
