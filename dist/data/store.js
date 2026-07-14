import bcrypt from 'bcryptjs';
const now = () => new Date().toISOString();
const users = [
    {
        id: '1',
        name: 'Admin',
        email: 'admin@qrshop.com',
        passwordHash: bcrypt.hashSync('password', 10),
    },
];
const customers = [
    {
        id: 'c1',
        name: 'Acme Trading',
        email: 'contact@acme.com',
        phone: '+95 9 123 456 789',
        company: 'Acme Trading Co.',
        createdAt: now(),
    },
    {
        id: 'c2',
        name: 'Golden Mart',
        email: 'hello@goldenmart.com',
        phone: '+95 9 987 654 321',
        company: 'Golden Mart Ltd.',
        createdAt: now(),
    },
];
const products = [
    {
        id: 'p1',
        name: 'QR Menu Stand',
        sku: 'QR-STD-01',
        price: 45000,
        stock: 120,
        active: true,
        createdAt: now(),
    },
    {
        id: 'p2',
        name: 'POS Tablet Bundle',
        sku: 'POS-TAB-01',
        price: 380000,
        stock: 35,
        active: true,
        createdAt: now(),
    },
];
const quotations = [
    {
        id: 'q1',
        reference: 'QUO-2026-001',
        customerId: 'c1',
        customerName: 'Acme Trading',
        status: 'sent',
        lines: [
            {
                productId: 'p1',
                productName: 'QR Menu Stand',
                quantity: 10,
                unitPrice: 45000,
                subtotal: 450000,
            },
        ],
        total: 450000,
        createdAt: now(),
    },
];
export const db = {
    users,
    customers,
    products,
    quotations,
};
export function findUserByEmail(email) {
    return db.users.find(user => user.email.toLowerCase() === email.toLowerCase());
}
export function findUserById(id) {
    return db.users.find(user => user.id === id);
}
