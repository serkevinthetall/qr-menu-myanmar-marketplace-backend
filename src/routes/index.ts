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
import authRoutes from './auth.routes.js';
import customersRoutes from './customers.routes.js';
import membershipCouponsRoutes from './membership-coupons.routes.js';
import membershipsRoutes from './memberships.routes.js';
import productsRoutes from './products.routes.js';
import purchaseOrdersRoutes from './purchase-orders.routes.js';
import quotationsRoutes from './quotations.routes.js';
import saleOrdersRoutes from './sale-orders.routes.js';

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
router.use('/purchase-orders', purchaseOrdersRoutes);
router.use('/sale-orders', saleOrdersRoutes);

/** Handheld sales-rep app API (separate from web ERP routes). */
router.use('/app', appRoutes);

export default router;
