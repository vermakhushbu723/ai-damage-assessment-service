import { db, nowIso } from '../db/database.js';

const toPlanDto = (r) => r && ({
    id: r.id,
    name: r.name,
    price: r.price,
    priceLabel: r.price_label,
    userLimit: r.user_limit,
    features: JSON.parse(r.features),
    subscribers: r.subscribers ?? 0,
    updatedOn: r.updated_at,
});

const SELECT = `SELECT p.*, (SELECT COUNT(*) FROM organizations o WHERE o.plan_id = p.id) AS subscribers FROM plans p`;

export const listPlans = () => db.prepare(`${SELECT} ORDER BY p.sort_order, p.name`).all().map(toPlanDto);
export const findPlan = (id) => toPlanDto(db.prepare(`${SELECT} WHERE p.id = ?`).get(id));

export function insertPlan({ id, name, price, priceLabel, userLimit, features, sortOrder }) {
    db.prepare('INSERT INTO plans (id, name, price, price_label, user_limit, features, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, name, price ?? null, priceLabel ?? null, userLimit, JSON.stringify(features), sortOrder ?? 0, nowIso());
    return findPlan(id);
}

export function updatePlan(id, { name, price, priceLabel, userLimit, features }) {
    const current = findPlan(id);
    db.prepare('UPDATE plans SET name = ?, price = ?, price_label = ?, user_limit = ?, features = ?, updated_at = ? WHERE id = ?').run(
        name ?? current.name,
        price === undefined ? current.price : price,
        priceLabel === undefined ? current.priceLabel : priceLabel,
        userLimit ?? current.userLimit,
        JSON.stringify(features ?? current.features),
        nowIso(),
        id,
    );
    return findPlan(id);
}

export const countPlans = () => db.prepare('SELECT COUNT(*) AS n FROM plans').get().n;
