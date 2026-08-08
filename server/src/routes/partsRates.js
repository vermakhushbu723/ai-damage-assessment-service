import { Router } from 'express';
import { db } from '../db/database.js';

const router = Router();

router.get('/api/v1/parts-rates', (req, res) => {
    const { make, model, year, region } = req.query;

    const clauses = [];
    const params = {};
    if (make) { clauses.push('make = @make'); params.make = make; }
    if (model) { clauses.push('model = @model'); params.model = model; }
    if (year) { clauses.push('year_from <= @year AND year_to >= @year'); params.year = Number(year); }
    if (region) { clauses.push('(region = @region OR region = \'default\')'); params.region = region; }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM parts_rates ${where} ORDER BY make, model, part`).all(params);
    return res.json(rows);
});

export default router;
