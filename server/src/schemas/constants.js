// Fixed value sets shared across validation schemas and business logic --
// the JS equivalent of the Python service's Enum classes (app/schemas.py).

export const VEHICLE_TYPES = ['car', 'two_wheeler', 'commercial_vehicle'];

export const DAMAGE_TYPES = ['dent', 'scratch', 'crack', 'shatter', 'deformation', 'tear', 'unknown'];

// The subset of DAMAGE_TYPES that's actually trainable -- 'unknown' is only
// ever placeholder-model output, never something a human annotates. Order
// here IS the YOLO class id (index 0 = class 0, etc.) -- it must stay in
// sync with training/scripts/prepare_dataset.py's DAMAGE_TYPE_NAMES and
// training/data/<vehicle_type>/data.yaml's `names:` list, or annotations
// saved here will silently train against the wrong class ids.
export const TRAINABLE_DAMAGE_TYPES = ['dent', 'scratch', 'crack', 'shatter', 'deformation', 'tear'];

export const SEVERITY_TIERS = ['minor', 'moderate', 'severe'];

export const REPAIR_ACTIONS = ['repair', 'replace'];

// Illustrative parts vocabulary for Annotation Studio's "part" tag --
// matches server/src/db/seed.js's sample parts-rate table. Not enforced as
// strictly as damage_type since it's metadata for the cost engine, not a
// YOLO class id -- feel free to extend for your own parts catalog.
export const PARTS = [
    'front_bumper', 'rear_bumper', 'bonnet', 'front_door_lh', 'front_door_rh',
    'rear_door_lh', 'rear_door_rh', 'fender_lh', 'fender_rh', 'headlamp_lh',
    'headlamp_rh', 'tail_light_lh', 'tail_light_rh', 'windshield_front',
    'windshield_rear', 'roof', 'boot_lid',
];
