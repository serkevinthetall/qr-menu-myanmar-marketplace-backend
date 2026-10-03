import { Router } from 'express';

import { env } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  connectMongo,
  isMongoConfigured,
} from '../config/mongo.js';
import { AppInstallModel } from '../models/app-install.model.js';
import {
  countPendingUnreadAppOrders,
  isAppOrderNotifyActive,
  seedPendingAppOrderIds,
} from '../services/app-order-notify.store.js';
import {
  listReadAppOrderIds,
} from '../services/app-order-read.store.js';
import {
  countOdooMembershipApplications,
  fetchOdooOnlineOrders,
} from '../services/odoo.service.js';
import { AuthRequest } from '../types/auth.js';

const router = Router();

router.use(authMiddleware);

/**
 * GET /api/badges — one light payload for sidebar / header badges.
 * Prefer this over polling three separate badge endpoints.
 *
 * App Order unread prefers the Odoo webhook notify bus (Redis) so the
 * website does not search_read 500 sale.orders on every poll.
 */
router.get('/', async (req: AuthRequest, res) => {
  const userId = req.user!.id;

  const memberRequestPromise = countOdooMembershipApplications(userId, {
    status: 'Requested',
  }).catch((error: unknown) => {
    console.error(
      '[badges] member-requests',
      error instanceof Error ? error.message : error,
    );
    return 0;
  });

  const appOrderUnreadPromise = (async () => {
    try {
      const readIds = await listReadAppOrderIds();
      if (await isAppOrderNotifyActive()) {
        return countPendingUnreadAppOrders(readIds);
      }

      // Cold start / webhook not configured yet — one Odoo pass, then seed Redis.
      const rows = await fetchOdooOnlineOrders(userId, {
        limit: 500,
        offset: 0,
      });
      const unreadIds = rows
        .filter(row => !readIds.has(row.id))
        .map(row => row.id);
      await seedPendingAppOrderIds(unreadIds);
      return unreadIds.length;
    } catch (error) {
      console.error(
        '[badges] app-order-unread',
        error instanceof Error ? error.message : error,
      );
      return 0;
    }
  })();

  const callListPromise = (async () => {
    if (!env.enableAppInstallCallList || !isMongoConfigured()) {
      return 0;
    }
    try {
      await connectMongo();
      return await AppInstallModel.countDocuments({ status: 'new' });
    } catch (error) {
      console.error(
        '[badges] call-list',
        error instanceof Error ? error.message : error,
      );
      return 0;
    }
  })();

  const [memberRequestCount, appOrderUnreadCount, callListNewCount] =
    await Promise.all([
      memberRequestPromise,
      appOrderUnreadPromise,
      callListPromise,
    ]);

  return res.json({
    data: {
      memberRequestCount,
      appOrderUnreadCount,
      callListNewCount,
    },
  });
});

export default router;
