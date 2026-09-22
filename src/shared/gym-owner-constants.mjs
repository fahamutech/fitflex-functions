// FitFlex Af — Gym Owner B2B Constants
// Extends the existing operator endpoints with CSV import, staff RBAC,
// multi-branch support, and custodial delivery station.

// ─────────────────────────────────────────────────────────────────────────────
// Staff Permissions (Granular RBAC)
// ─────────────────────────────────────────────────────────────────────────────
export const STAFF_PERMISSIONS = {
  MANAGE_CHECKIN: 'manage_checkin',           // front desk check-in terminal
  MANAGE_GYM_DETAILS: 'manage_gym_details',  // edit facility info, amenities, hours
  MANAGE_DIRECT_MEMBERS: 'manage_direct_members', // add/edit direct (walk-in) members
  ACCESS_VISIT_REPORTS: 'access_visit_reports',   // view analytics & occupancy
  ACCESS_FINANCIALS: 'access_financials',    // view payout & revenue data
  MANAGE_GYM_SHOP: 'manage_gym_shop',        // custodial delivery desk for marketplace
  MANAGE_STAFF: 'manage_staff',              // add/edit/remove staff
  MANAGE_CLASSES: 'manage_classes'            // create/edit group fitness classes
};

export const ALL_PERMISSIONS = Object.values(STAFF_PERMISSIONS);

// ─────────────────────────────────────────────────────────────────────────────
// Staff Roles (preset permission bundles)
// ─────────────────────────────────────────────────────────────────────────────
export const STAFF_ROLES = {
  owner: {
    label: 'Gym Owner',
    permissions: ALL_PERMISSIONS // owner has all permissions
  },
  manager: {
    label: 'Manager',
    permissions: [
      STAFF_PERMISSIONS.MANAGE_CHECKIN,
      STAFF_PERMISSIONS.MANAGE_GYM_DETAILS,
      STAFF_PERMISSIONS.MANAGE_DIRECT_MEMBERS,
      STAFF_PERMISSIONS.ACCESS_VISIT_REPORTS,
      STAFF_PERMISSIONS.ACCESS_FINANCIALS,
      STAFF_PERMISSIONS.MANAGE_CLASSES
    ]
  },
  receptionist: {
    label: 'Front Desk Receptionist',
    permissions: [
      STAFF_PERMISSIONS.MANAGE_CHECKIN,
      STAFF_PERMISSIONS.MANAGE_DIRECT_MEMBERS,
      STAFF_PERMISSIONS.ACCESS_VISIT_REPORTS,
      STAFF_PERMISSIONS.MANAGE_GYM_SHOP
    ]
  },
  instructor: {
    label: 'Group Fitness Instructor',
    permissions: [
      STAFF_PERMISSIONS.MANAGE_CLASSES,
      STAFF_PERMISSIONS.MANAGE_CHECKIN
    ]
  },
  trainer: {
    label: 'Personal Trainer',
    permissions: [
      STAFF_PERMISSIONS.MANAGE_CHECKIN
    ]
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Direct Member Pass Types
// ─────────────────────────────────────────────────────────────────────────────
export const DIRECT_MEMBER_PASS_TYPES = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  ANNUAL: 'annual'
};

// ─────────────────────────────────────────────────────────────────────────────
// CSV Import Header Mapping (English + Swahili)
// Supports both comma-separated (CSV) and tab-separated (Excel paste) formats.
// ─────────────────────────────────────────────────────────────────────────────
export const CSV_HEADER_MAP = {
  // English headers
  'name': 'name',
  'first name': 'firstName',
  'firstname': 'firstName',
  'last name': 'lastName',
  'lastname': 'lastName',
  'phone': 'phone',
  'mobile': 'phone',
  'number': 'phone',
  'email': 'email',
  'pass type': 'passType',
  'passtype': 'passType',
  'package': 'passType',
  'amount': 'amount',
  'price': 'amount',
  'start date': 'startDate',
  'startdate': 'startDate',
  'date': 'startDate',
  'tarehe': 'startDate',
  'end date': 'endDate',
  'enddate': 'endDate',
  'expiry': 'endDate',
  // Swahili headers
  'jina': 'name',
  'jina la kwanza': 'firstName',
  'jina la mwisho': 'lastName',
  'simu': 'phone',
  'nambari': 'phone',
  'barua pepe': 'email',
  'kifurushi': 'passType',
  'bei': 'amount',
  'kiasi': 'amount',
  'kituo': 'gymName',
  'gym': 'gymName'
};

// ─────────────────────────────────────────────────────────────────────────────
// CSV Import Parser
// Parses raw CSV or tab-separated text into structured member records.
// Auto-maps English and Swahili headers.
// ─────────────────────────────────────────────────────────────────────────────
export function parseCsvImport(rawText) {
  if (!rawText || typeof rawText !== 'string')
    return { ok: false, error: 'invalid_input', parsed: [] };

  // Detect delimiter (tab or comma)
  const delimiter = rawText.includes('\t') ? '\t' : ',';
  const lines = rawText.trim().split(/\r?\n/).filter(l => l.trim());

  if (lines.length < 2)
    return { ok: false, error: 'need_header_and_at_least_one_row', parsed: [] };

  // Parse header row
  const headerRow = lines[0].split(delimiter).map(h => h.trim().toLowerCase());
  const columnMap = headerRow.map(h => CSV_HEADER_MAP[h] || h);

  const parsed = [];
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delimiter).map(c => c.trim());

    const record = {};
    for (let j = 0; j < columnMap.length; j++) {
      const key = columnMap[j];
      const value = cells[j] || '';
      if (key && value) record[key] = value;
    }

    // Validate: must have at least a name or phone
    if (!record.name && !record.firstName && !record.phone) {
      errors.push({ row: i + 1, error: 'missing_name_or_phone' });
      continue;
    }

    // Normalize name: combine firstName + lastName if separate
    if (!record.name && record.firstName) {
      record.name = [record.firstName, record.lastName].filter(Boolean).join(' ');
    }

    // Normalize pass type
    if (record.passType) {
      const pt = record.passType.toLowerCase();
      if (pt.includes('day') || pt.includes('siku')) record.passType = DIRECT_MEMBER_PASS_TYPES.DAILY;
      else if (pt.includes('week') || pt.includes('wiki')) record.passType = DIRECT_MEMBER_PASS_TYPES.WEEKLY;
      else if (pt.includes('month') || pt.includes('mwezi')) record.passType = DIRECT_MEMBER_PASS_TYPES.MONTHLY;
      else if (pt.includes('year') || pt.includes('mwaka') || pt.includes('annual')) record.passType = DIRECT_MEMBER_PASS_TYPES.ANNUAL;
      else record.passType = DIRECT_MEMBER_PASS_TYPES.MONTHLY; // default
    }

    // Normalize amount
    if (record.amount) {
      record.amount = Number(record.amount.replace(/[^0-9.-]/g, '')) || 0;
    }

    record.rowNumber = i + 1;
    parsed.push(record);
  }

  return { ok: true, parsed, errors, totalRows: lines.length - 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Amenity Keys (standard toggleable amenities)
// ─────────────────────────────────────────────────────────────────────────────
export const AMENITIES = [
  'showers', 'steam_bath', 'sauna', 'lockers', 'dedicated_cafe',
  'free_wifi', 'water_dispenser', 'air_conditioning', 'free_parking',
  'changing_rooms', 'pool', 'juice_bar', 'towel_service'
];

// ─────────────────────────────────────────────────────────────────────────────
// Equipment Inventory Keys
// ─────────────────────────────────────────────────────────────────────────────
export const EQUIPMENT_INVENTORY = [
  'cardio_treadmills', 'cardio_ellipticals', 'cardio_spin_bikes', 'cardio_rowing_machines',
  'free_weights_dumbbells', 'free_weights_kettlebells', 'free_weights_barbells',
  'squat_racks', 'smith_machines', 'cable_crossovers', 'bench_press', 'power_rack',
  'functional_zone', 'battle_ropes', 'medicine_balls', 'plyo_boxes'
];

// ─────────────────────────────────────────────────────────────────────────────
// Operating Hours Default
// ─────────────────────────────────────────────────────────────────────────────
export const DEFAULT_OPERATING_HOURS = {
  weekday: { open: '06:00', close: '22:00' },
  weekend: { open: '07:00', close: '21:00' }
};
