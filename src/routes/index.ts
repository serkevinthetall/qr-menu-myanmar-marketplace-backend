import { Router } from 'express';

/**
 * API route map
 *
 * WEB ERP (desktop website):
 *   /api/health
 *   /api/auth/*
 *   /api/badges
 *   /api/customers/*
 *   /api/products/*
 *   /api/inventory/*
 *   /api/quotations/*
 *   /api/memberships/*
 *   /api/membership-coupons/*
 *   /api/purchase-orders/*
 *   /api/bills-of-materials/*
 *   /api/sale-orders/*
 *   /api/online-orders/*
 *   /api/insights/*
 *   /api/monthly-rebate-reviews/*
 *   /api/vendor-bills/*
 *   /api/vendor-payments/*
 *   /api/journal-entries/*
 *   /api/reconcile/*
 *   /api/chart-of-accounts/*
 *   /api/customer-invoices/*
 *   /api/telegram/*   (webhook, Vercel cron, daily report)
 *   /api/odoo/*       (Odoo → ERP webhooks, no JWT)
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
import badgesRoutes from './badges.routes.js';
import billsOfMaterialsRoutes from './bills-of-materials.routes.js';
import customersRoutes from './customers.routes.js';
import insightsRoutes from './insights.routes.js';
import inventoryRoutes from './inventory.routes.js';
import membershipCouponsRoutes from './membership-coupons.routes.js';
import membershipsRoutes from './memberships.routes.js';
import memberRequestsRoutes from './member-requests.routes.js';
import monthlyRebateReviewsRoutes from './monthly-rebate-reviews.routes.js';
import onlineOrdersRoutes from './online-orders.routes.js';
import productsRoutes from './products.routes.js';
import purchaseOrdersRoutes from './purchase-orders.routes.js';
import quotationsRoutes from './quotations.routes.js';
import saleOrdersRoutes from './sale-orders.routes.js';
import telegramRoutes from './telegram.routes.js';
import chartOfAccountsRoutes from './chart-of-accounts.routes.js';
import customerInvoicesRoutes from './customer-invoices.routes.js';
import journalEntriesRoutes from './journal-entries.routes.js';
import reconcileRoutes from './reconcile.routes.js';
import vendorBillsRoutes from './vendor-bills.routes.js';
import vendorPaymentsRoutes from './vendor-payments.routes.js';
import odooWebhookRoutes from './odoo-webhook.routes.js';
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
router.use('/badges', badgesRoutes);
router.use('/customers', customersRoutes);
router.use('/products', productsRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/quotations', quotationsRoutes);
router.use('/memberships', membershipsRoutes);
router.use('/membership-coupons', membershipCouponsRoutes);
router.use('/member-requests', memberRequestsRoutes);
router.use('/purchase-orders', purchaseOrdersRoutes);
router.use('/bills-of-materials', billsOfMaterialsRoutes);
router.use('/sale-orders', saleOrdersRoutes);
router.use('/online-orders', onlineOrdersRoutes);
router.use('/monthly-rebate-reviews', monthlyRebateReviewsRoutes);
router.use('/vendor-bills', vendorBillsRoutes);
router.use('/vendor-payments', vendorPaymentsRoutes);
router.use('/journal-entries', journalEntriesRoutes);
router.use('/reconcile', reconcileRoutes);
router.use('/chart-of-accounts', chartOfAccountsRoutes);
router.use('/customer-invoices', customerInvoicesRoutes);
router.use('/insights', insightsRoutes);
router.use('/telegram', telegramRoutes);
router.use('/odoo', odooWebhookRoutes);
// @temp-feature app-install-call-list
if (env.enableAppInstallCallList) {
  router.use('/app-installs', appInstallsRoutes);
  router.use('/app-promoters', appPromotersRoutes);
  router.use('/app-promoter-commissions', appPromoterCommissionsRoutes);
}

/** Handheld sales-rep app API (separate from web ERP routes). */
router.use('/app', appRoutes);

export default router;
