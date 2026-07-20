import { Router } from 'express';

/**
 * Phone / sales-rep API surface — mounted at `/api/app`.
 *
 * | Area        | Path                         |
 * |-------------|------------------------------|
 * | Health      | GET  /api/app/health         |
 * | Auth        | /api/app/auth/*              |
 * | Contacts    | /api/app/contacts/*          |
 * | Products    | /api/app/products/*          |
 * | Quotations  | /api/app/quotations/*        |
 *
 * Website ERP uses `/api/auth`, `/api/customers`, `/api/products`, `/api/quotations`
 * and must not call these routes.
 */
import authRoutes from './auth.routes.js';
import contactsRoutes from './contacts.routes.js';
import productsRoutes from './products.routes.js';
import quotationsRoutes from './quotations.routes.js';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'qr-shop-sales-rep-app',
    surface: 'app',
    timestamp: new Date().toISOString(),
  });
});

router.use('/auth', authRoutes);
router.use('/contacts', contactsRoutes);
router.use('/products', productsRoutes);
router.use('/quotations', quotationsRoutes);

export default router;
