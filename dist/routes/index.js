import { Router } from 'express';
import authRoutes from './auth.routes.js';
import customersRoutes from './customers.routes.js';
import productsRoutes from './products.routes.js';
import quotationsRoutes from './quotations.routes.js';
const router = Router();
router.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        service: 'qr-shop-erp-api',
        timestamp: new Date().toISOString(),
    });
});
router.use('/auth', authRoutes);
router.use('/customers', customersRoutes);
router.use('/products', productsRoutes);
router.use('/quotations', quotationsRoutes);
export default router;
