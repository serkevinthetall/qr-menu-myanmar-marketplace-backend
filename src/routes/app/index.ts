import { Router } from 'express';

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
