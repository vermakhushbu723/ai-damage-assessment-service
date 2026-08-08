// Seeds a small sample Parts Rate table so the API is usable out of the box.
// Replace with a real import from your actual parts-rate feed
// (make/model/year/part/region -> cost) before going anywhere near
// production -- this is illustrative sample data only.

import { db } from './database.js';

const SAMPLE_RATES = [
    // make, model, year_from, year_to, part, region, part_cost, labor_cost, paint
    ['Maruti Suzuki', 'Swift', 2018, 2024, 'front_bumper', 'default', 4200, 1200, 1800],
    ['Maruti Suzuki', 'Swift', 2018, 2024, 'rear_bumper', 'default', 3900, 1200, 1800],
    ['Maruti Suzuki', 'Swift', 2018, 2024, 'bonnet', 'default', 6500, 1500, 2200],
    ['Maruti Suzuki', 'Swift', 2018, 2024, 'front_door_lh', 'default', 8200, 1800, 2400],
    ['Maruti Suzuki', 'Swift', 2018, 2024, 'front_door_rh', 'default', 8200, 1800, 2400],
    ['Maruti Suzuki', 'Swift', 2018, 2024, 'headlamp_lh', 'default', 3100, 600, 0],
    ['Maruti Suzuki', 'Swift', 2018, 2024, 'headlamp_rh', 'default', 3100, 600, 0],
    ['Maruti Suzuki', 'Swift', 2018, 2024, 'windshield_front', 'default', 5200, 900, 0],
    ['Hyundai', 'Creta', 2020, 2025, 'front_bumper', 'default', 6800, 1600, 2200],
    ['Hyundai', 'Creta', 2020, 2025, 'rear_bumper', 'default', 6400, 1600, 2200],
    ['Hyundai', 'Creta', 2020, 2025, 'bonnet', 'default', 9200, 1800, 2600],
    ['Hyundai', 'Creta', 2020, 2025, 'front_door_lh', 'default', 11500, 2200, 2800],
    ['Hyundai', 'Creta', 2020, 2025, 'front_door_rh', 'default', 11500, 2200, 2800],
    ['Hyundai', 'Creta', 2020, 2025, 'fender_lh', 'default', 5200, 1400, 1900],
    ['Hyundai', 'Creta', 2020, 2025, 'fender_rh', 'default', 5200, 1400, 1900],
    ['Tata', 'Nexon', 2019, 2025, 'front_bumper', 'default', 5600, 1400, 2000],
    ['Tata', 'Nexon', 2019, 2025, 'rear_bumper', 'default', 5300, 1400, 2000],
    ['Tata', 'Nexon', 2019, 2025, 'tail_light_lh', 'default', 2800, 500, 0],
    ['Tata', 'Nexon', 2019, 2025, 'tail_light_rh', 'default', 2800, 500, 0],
    ['Honda', 'Activa', 2018, 2025, 'front_panel', 'default', 1800, 500, 800],
    ['Honda', 'Activa', 2018, 2025, 'side_panel_lh', 'default', 1500, 500, 800],
    ['Honda', 'Activa', 2018, 2025, 'side_panel_rh', 'default', 1500, 500, 800],
    ['Honda', 'Activa', 2018, 2025, 'headlamp', 'default', 1200, 300, 0],
    ['Tata', 'Ace', 2017, 2025, 'front_bumper', 'default', 7200, 2200, 2600],
    ['Tata', 'Ace', 2017, 2025, 'cabin_door_lh', 'default', 9800, 2600, 3000],
    ['Tata', 'Ace', 2017, 2025, 'cabin_door_rh', 'default', 9800, 2600, 3000],
    ['Tata', 'Ace', 2017, 2025, 'headlamp_lh', 'default', 2600, 700, 0],
];

export function seedPartsRates() {
    const existing = db.prepare('SELECT id FROM parts_rates LIMIT 1').get();
    if (existing) return; // already seeded

    const insert = db.prepare(`
        INSERT INTO parts_rates
            (make, model, year_from, year_to, part, region, part_cost, labor_cost, paint_consumables_cost)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.exec('BEGIN');
    try {
        for (const row of SAMPLE_RATES) insert.run(...row);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
