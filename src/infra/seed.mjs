// Seed demo gyms and demo portal users. Idempotent.
import { collection } from './json-store.mjs';

const PILOT_ADMIN_EMAIL = 'mama27j@gmail.com';
const LEGACY_ADMIN_EMAIL = 'admin@fitflex.af';
const GYM_DEFAULTS = {
  gym_001: {
    accessMode: 'paid_visit',
    venueType: 'physical',
    coordinates: { lat: -6.7469, lng: 39.2666 },
    images: ['https://images.unsplash.com/photo-1534438327276-14e5300c3a48?auto=format&fit=crop&w=1200&q=80']
  },
  gym_002: {
    accessMode: 'paid_visit',
    venueType: 'physical',
    coordinates: { lat: -6.7707, lng: 39.2434 },
    images: ['https://images.unsplash.com/photo-1571902943202-507ec2618e8f?auto=format&fit=crop&w=1200&q=80']
  },
  gym_003: {
    accessMode: 'paid_visit',
    venueType: 'physical',
    coordinates: { lat: -6.7617, lng: 39.2873 },
    images: ['https://images.unsplash.com/photo-1558611848-73f7eb4001a1?auto=format&fit=crop&w=1200&q=80']
  },
  gym_004: {
    accessMode: 'paid_visit',
    venueType: 'physical',
    coordinates: { lat: -6.8162, lng: 39.2886 },
    images: ['https://images.unsplash.com/photo-1540497077202-7c8a3999166f?auto=format&fit=crop&w=1200&q=80']
  },
  gym_005: {
    accessMode: 'paid_visit',
    venueType: 'physical',
    coordinates: { lat: -6.163, lng: 39.189 },
    images: ['https://images.unsplash.com/photo-1517836357463-d25dfeac3438?auto=format&fit=crop&w=1200&q=80']
  }
};

export function ensureSeed() {
  const gyms = collection('gyms');
  if (gyms.all().length === 0) {
    [
      { id: 'gym_001', name: 'Iron Paradise Masaki',     tier: 'standard',         location: 'Dar es Salaam, Masaki',   perVisitRate: 5_000,  commissionRate: 12, status: 'active', operatingHours: { default: { open: '06:00', close: '22:00' } }, ...GYM_DEFAULTS.gym_001 },
      { id: 'gym_002', name: 'PowerHouse Mikocheni',     tier: 'midtier',          location: 'Dar es Salaam, Mikocheni', perVisitRate: 8_000,  commissionRate: 12, status: 'active', operatingHours: { default: { open: '05:30', close: '23:00' } }, ...GYM_DEFAULTS.gym_002 },
      { id: 'gym_003', name: 'Elite Fitness Oysterbay',  tier: 'premium',          location: 'Dar es Salaam, Oysterbay', perVisitRate: 13_000, commissionRate: 12, status: 'active', operatingHours: { default: { open: '05:00', close: '23:30' } }, ...GYM_DEFAULTS.gym_003 },
      { id: 'gym_004', name: 'Serena Wellness Club',     tier: 'luxury_executive', location: 'Dar es Salaam, City Centre', perVisitRate: 22_500, commissionRate: 10, status: 'active', operatingHours: { default: { open: '06:00', close: '22:00' } }, ...GYM_DEFAULTS.gym_004 },
      { id: 'gym_005', name: 'Stone Town Strength',      tier: 'standard',         location: 'Zanzibar, Stone Town',     perVisitRate: 5_000,  commissionRate: 12, status: 'active', operatingHours: { default: { open: '06:00', close: '21:00' } }, ...GYM_DEFAULTS.gym_005 }
    ].forEach(g => gyms.insert(g));
  } else {
    gyms.all().forEach(g => {
      const defaults = GYM_DEFAULTS[g.id] || {
        accessMode: g.accessMode || 'paid_visit',
        venueType: g.venueType || 'physical',
        coordinates: g.coordinates || { lat: null, lng: null },
        images: g.images || []
      };
      gyms.update(row => row.id === g.id, {
        accessMode: g.accessMode || defaults.accessMode,
        venueType: g.venueType || defaults.venueType,
        coordinates: g.coordinates || defaults.coordinates,
        images: g.images || defaults.images
      });
    });
  }

  const users = collection('users');
  if (!users.find(u => u.email === 'operator@iron-paradise.tz')) {
    users.insert({
      id: 'usr_op_1', userType: 'gym_operator', email: 'operator@iron-paradise.tz',
      passwordHash: 'demo:operator123', // demo credentials only — replace with bcrypt
      gymId: 'gym_001', createdAt: new Date().toISOString()
    });
  }
  const currentAdmin = users.find(u => u.email === PILOT_ADMIN_EMAIL);
  const legacyAdmin = users.find(u => u.email === LEGACY_ADMIN_EMAIL);
  if (currentAdmin) {
    users.update(u => u.id === currentAdmin.id, {
      userType: 'admin',
      passwordHash: currentAdmin.passwordHash || 'demo:admin123'
    });
  } else if (legacyAdmin) {
    users.update(u => u.id === legacyAdmin.id, {
      userType: 'admin',
      email: PILOT_ADMIN_EMAIL,
      passwordHash: legacyAdmin.passwordHash || 'demo:admin123',
      firebaseUid: null
    });
  } else {
    users.insert({
      id: 'usr_admin_1', userType: 'admin', email: PILOT_ADMIN_EMAIL,
      passwordHash: 'demo:admin123', createdAt: new Date().toISOString()
    });
  }

  const trainers = collection('trainers');
  if (trainers.all().length === 0) {
    [
      {
        id: 'trn_ali',
        displayName: 'Coach Ali Rashid',
        specialties: ['Weight Training', 'HIIT'],
        bio: 'Certified personal trainer specialising in strength, conditioning and HIIT.',
        rating: 4.9,
        reviewCount: 84,
        hourlyRateTzs: 25_000,
        experienceYears: 8,
        gymIds: ['gym_001', 'gym_002'],
        status: 'active',
        availability: [
          { date: '2026-05-05', slots: ['09:00', '10:00', '11:00'] },
          { date: '2026-05-06', slots: ['08:00', '17:00'] }
        ]
      },
      {
        id: 'trn_amina',
        displayName: 'Amina Shariff',
        specialties: ['Yoga', 'Flexibility'],
        bio: 'Mobility and yoga coach for beginners and experienced athletes.',
        rating: 4.7,
        reviewCount: 51,
        hourlyRateTzs: 20_000,
        experienceYears: 6,
        gymIds: ['gym_002', 'gym_003'],
        status: 'active',
        availability: [{ date: '2026-05-05', slots: ['07:00', '18:00'] }]
      },
      {
        id: 'trn_david',
        displayName: 'David Mwangi',
        specialties: ['Personal Training', 'Cardio'],
        bio: 'Performance-focused coach for cardio, strength and body recomposition.',
        rating: 4.8,
        reviewCount: 63,
        hourlyRateTzs: 30_000,
        experienceYears: 7,
        gymIds: ['gym_001', 'gym_005'],
        status: 'active',
        availability: [{ date: '2026-05-07', slots: ['06:00', '12:00', '19:00'] }]
      }
    ].forEach(t => trainers.insert(t));
  }
}
