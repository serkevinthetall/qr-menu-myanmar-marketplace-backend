import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { fetchOdooProducts } from '../services/odoo.service.js';
const router = Router();
router.use(authMiddleware);
router.get('/', async (req, res) => {
    try {
        const products = await fetchOdooProducts(req.user.id);
        const data = products.map(product => ({
            id: String(product.id),
            name: product.name,
            sku: product.default_code || '',
            price: product.list_price ?? 0,
            stock: product.qty_available ?? 0,
            active: product.active,
            category: Array.isArray(product.categ_id) ? product.categ_id[1] : '',
            // Images omitted on list fetch for speed; UI uses ProductThumb placeholder.
            image: '',
            unit: Array.isArray(product.uom_id) ? product.uom_id[1] : 'Units',
        }));
        return res.json({ data });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load products.';
        return res.status(500).json({ message });
    }
});
export default router;
