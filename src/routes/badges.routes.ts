import { Router } from 'express';

import { env } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  connectMongo,
  isMongoConfigured,
} from '../config/mongo.js';
import { AppInstallModel } from '../models/app-install.model.js';
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
      const rows = await fetchOdooOnlineOrders(userId, {
        limit: 500,
        offset: 0,
      });
      const readIds = await listReadAppOrderIds();
      return rows.reduce(
        (count, row) => count + (readIds.has(row.id) ? 0 : 1),
        0,
      );
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
