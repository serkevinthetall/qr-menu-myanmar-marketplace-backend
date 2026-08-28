import { Router } from 'express';

/**
 * API route map
 *
 * WEB ERP (desktop website):
 *   /api/health
 *   /api/auth/*
 *   /api/customers/*
 *   /api/products/*
 *   /api/quotations/*
 *   /api/memberships/*
 *   /api/membership-coupons/*
 *   /api/purchase-orders/*
 *   /api/sale-orders/*
 *   /api/online-orders/*
 *   /api/insights/*
 *
 * PHONE APP (sales-rep handheld):
 *   /api/app/health
 *   /api/app/auth/*
 *   /api/app/contacts/*
 *   /api/app/products/*
 *   /api/app/quotations/*
 *
 * Keep these surfaces separate. Do not mount web-only handlers under /app
 * or call /app from the website client.
 */
import appRoutes from './app/index.js';
// @temp-feature app-install-call-list — remove import + mount below when dropping feature
import appInstallsRoutes from './app-installs.routes.js';
import appPromoterCommissionsRoutes from './app-promoter-commissions.routes.js';
import appPromotersRoutes from './app-promoters.routes.js';
import authRoutes from './auth.routes.js';
import customersRoutes from './customers.routes.js';
import insightsRoutes from './insights.routes.js';
import membershipCouponsRoutes from './membership-coupons.routes.js';
import membershipsRoutes from './memberships.routes.js';
import memberRequestsRoutes from './member-requests.routes.js';
import onlineOrdersRoutes from './online-orders.routes.js';
import productsRoutes from './products.routes.js';
import purchaseOrdersRoutes from './purchase-orders.routes.js';
import quotationsRoutes from './quotations.routes.js';
import saleOrdersRoutes from './sale-orders.routes.js';
import { env } from '../config/env.js';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'qr-shop-erp-api',
    surface: 'web',
    timestamp: new Date().toISOString(),
  });
});

router.use('/auth', authRoutes);
router.use('/customers', customersRoutes);
router.use('/products', productsRoutes);
router.use('/quotations', quotationsRoutes);
router.use('/memberships', membershipsRoutes);
router.use('/membership-coupons', membershipCouponsRoutes);
router.use('/member-requests', memberRequestsRoutes);
router.use('/purchase-orders', purchaseOrdersRoutes);
router.use('/sale-orders', saleOrdersRoutes);
router.use('/online-orders', onlineOrdersRoutes);
router.use('/insights', insightsRoutes);
// @temp-feature app-install-call-list
if (env.enableAppInstallCallList) {
  router.use('/app-installs', appInstallsRoutes);
  router.use('/app-promoters', appPromotersRoutes);
  router.use('/app-promoter-commissions', appPromoterCommissionsRoutes);
}

/** Handheld sales-rep app API (separate from web ERP routes). */
router.use('/app', appRoutes);

export default router;
