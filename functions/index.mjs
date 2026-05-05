// FitFlex Af — public REST surface (bfast-functions).
// All business logic delegated to ../src/services/* (clean architecture + DI).

import { randomUUID } from 'node:crypto';
import { collection } from '../src/infra/prisma-store.mjs';
import { ensureSeedPrisma } from '../src/infra/seed-prisma.mjs';
import { sign as signJwt, requireAuth } from '../src/auth/jwt.mjs';
import { verifyFirebaseIdToken } from '../src/auth/firebase.mjs';
import { issue as issueQr, verify as verifyQr } from '../src/auth/qr-token.mjs';
import { createCheckInService } from '../src/services/check-in-service.mjs';
import { PASS_TIERS } from '../src/shared/constants.mjs';
import { calculatePayout } from '../src/shared/payout-engine.mjs';

const created = new Date().toISOString();
const users = collection('users');
const gyms = collection('gyms');
const subscriptions = collection('subscriptions');
const checkins = collection('checkins');
const otps = collection('otps');
const auditLog = collection('audit_log');
const paymentRequests = collection('payment_requests');
const trainers = collection('trainers');
const trainerBookings = collection('trainer_bookings');

// Lazy init: seed + prime on first request (no top-level await for bfast compat)
let _initDone = false;
let _initPromise = null;
function ensureInit() {
  if (_initDone) return Promise.resolve();
  if (!_initPromise) {
    _initPromise = (async () => {
      await ensureSeedPrisma();
      await Promise.all([
        users.ready, gyms.ready, subscriptions.ready, checkins.ready, otps.ready,
        auditLog.ready, paymentRequests.ready, trainers.ready, trainerBookings.ready,
      ]);
      _initDone = true;
      console.log('[fitflex] All collections primed from PostgreSQL.');
    })();
  }
  return _initPromise;
}
// Fire init eagerly (non-blocking) so it's ready before first request
ensureInit();

const checkInService = createCheckInService({ users, gyms, subscriptions, checkins });
const configuredAdminEmails = new Set(
  (process.env.FITFLEX_ADMIN_EMAILS || 'mama27j@gmail.com')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean)
);

function isConfiguredAdminEmail(email) {
  return Boolean(email && configuredAdminEmails.has(String(email).toLowerCase()));
}

function normalizeRequestedRole(role) {
  if (role === 'gym_owner' || role === 'gym_operator') return 'gym_operator';
  if (role === 'trainer') return 'trainer';
  return 'member';
}

function approvalStatusForRole(role) {
  return ['gym_operator', 'trainer'].includes(role) ? 'pending_approval' : 'approved';
}

function normalizeGymPayload(body = {}, prior = {}) {
  const images = Array.isArray(body.images)
    ? body.images
    : String(body.images || prior.images?.join('\n') || '')
      .split(/\n|,/)
      .map(url => url.trim())
      .filter(Boolean);
  const lat = body.coordinates?.lat ?? body.lat ?? prior.coordinates?.lat ?? null;
  const lng = body.coordinates?.lng ?? body.lng ?? prior.coordinates?.lng ?? null;
  const venueType = body.venueType ?? prior.venueType ?? 'physical';
  const accessMode = body.accessMode ?? prior.accessMode ?? 'paid_visit';
  const isOnlineFree = venueType === 'online' || accessMode === 'free_online';
  return {
    id: body.id || prior.id,
    status: body.status || prior.status || 'active',
    commissionRate: Number(body.commissionRate ?? prior.commissionRate ?? 12),
    name: body.name ?? prior.name,
    tier: isOnlineFree ? 'online' : (body.tier ?? prior.tier ?? 'standard'),
    location: body.location ?? prior.location,
    perVisitRate: isOnlineFree ? 0 : Number(body.perVisitRate ?? prior.perVisitRate ?? 0),
    accessMode: isOnlineFree ? 'free_online' : accessMode,
    venueType,
    coordinates: {
      lat: lat === null || lat === '' ? null : Number(lat),
      lng: lng === null || lng === '' ? null : Number(lng)
    },
    ratePerDay: Number(body.ratePerDay ?? prior.ratePerDay ?? body.perVisitRate ?? prior.perVisitRate ?? 0),
    ratePerWeek: Number(body.ratePerWeek ?? prior.ratePerWeek ?? 0),
    ratePerMonth: Number(body.ratePerMonth ?? prior.ratePerMonth ?? 0),
    images,
    operatingHours: body.operatingHours ?? prior.operatingHours ?? null,
    amenities: Array.isArray(body.amenities) ? body.amenities : (prior.amenities || []),
    equipment: Array.isArray(body.equipment) ? body.equipment : (prior.equipment || []),
  };
}

function latestMemberSubscription(memberId) {
  return subscriptions
    .filter(s => s.memberId === memberId)
    .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0] || null;
}

function hydrateTrainer(row) {
  const linkedGyms = (row.gymIds || [])
    .map(id => gyms.find(g => g.id === id))
    .filter(Boolean);
  return { ...row, gyms: linkedGyms };
}

function parseStringList(value, fallback = []) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/\n|,/).map(v => v.trim()).filter(Boolean);
  return fallback;
}

function normalizeTrainerPayload(body = {}, prior = {}) {
  const gymIds = parseStringList(body.gymIds, prior.gymIds || []);
  const specialties = parseStringList(body.specialties, prior.specialties || []);
  return {
    id: body.id || prior.id || `trn_${randomUUID().slice(0, 8)}`,
    userId: body.userId ?? prior.userId ?? null,
    email: body.email ?? prior.email ?? null,
    displayName: body.displayName ?? prior.displayName,
    photoUrl: body.photoUrl ?? prior.photoUrl ?? null,
    specialties,
    bio: body.bio ?? prior.bio ?? '',
    rating: Number(body.rating ?? prior.rating ?? 0),
    reviewCount: Number(body.reviewCount ?? prior.reviewCount ?? 0),
    hourlyRateTzs: Number(body.hourlyRateTzs ?? prior.hourlyRateTzs ?? 0),
    experienceYears: Number(body.experienceYears ?? prior.experienceYears ?? 0),
    gymIds,
    status: body.status ?? prior.status ?? 'active',
    approvalStatus: body.approvalStatus ?? prior.approvalStatus ?? 'approved',
    availability: Array.isArray(body.availability) ? body.availability : (prior.availability || []),
    createdAt: prior.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function hydrateGymOwner(row) {
  return { ...row, accountStatus: row.accountStatus || 'active', gym: row.gymId ? gyms.find(g => g.id === row.gymId) || null : null };
}

function hydrateTrainerBooking(row) {
  return {
    ...row,
    member: users.find(u => u.id === row.memberId) || null,
    trainer: row.trainerId ? hydrateTrainer(trainers.find(t => t.id === row.trainerId) || {}) : null,
    gym: gyms.find(g => g.id === row.gymId) || null
  };
}

function applyPaymentStatusToSubscription(request, status, reference) {
  const subStatus = {
    approved: 'active',
    rejected: 'payment_rejected',
    cancelled: 'payment_cancelled',
    pending: 'payment_pending'
  }[status];
  if (!subStatus) return;
  subscriptions.update(s => s.id === request.subscriptionId, {
    status: subStatus,
    paymentRef: status === 'approved' ? (reference || `ADMIN_${request.id}`) : null
  });
}

// ───────────────────────────────────────── Health ─────────────────────────────────────────
export const health = {
  created, method: 'get', path: '/health',
  description: 'Liveness probe',
  responseSample: { status: 'ok' },
  onRequest: (_, res) => res.status(200).json({ status: 'ok', service: 'fitflex-functions' })
};

// ───────────────────────────────────────── Auth: OTP ──────────────────────────────────────
export const authRequestOtp = {
  created, method: 'post', path: '/auth/otp/request',
  description: 'Request a phone OTP. Returns the OTP in dev mode (replace with SMS in prod).',
  requestSample: { phone: '+255712345678', userType: 'member' },
  responseSample: { ok: true, devOtp: '123456' },
  onRequest: (req, res) => {
    const { phone, userType = 'member' } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone_required' });
    if (!['member', 'trainer', 'gym_operator', 'admin'].includes(userType))
      return res.status(400).json({ error: 'invalid_userType' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    otps.upsert(o => o.phone === phone, { phone, code, userType, expiresAt: Date.now() + 5 * 60_000 });
    // ⚠️ In production, the OTP is sent via SMS (wire to provider). Dev mode returns in payload.
    const isProd = process.env.NODE_ENV === 'production';
    res.json({ ok: true, ...(isProd ? {} : { devOtp: code }), message: isProd ? 'OTP sent via SMS' : 'OTP sent (dev mode returns code in payload)' });
  }
};

export const authVerifyOtp = {
  created, method: 'post', path: '/auth/otp/verify',
  description: 'Verify OTP, create user if new, return JWT.',
  requestSample: { phone: '+255712345678', code: '123456' },
  responseSample: { token: 'jwt...', user: { id: 'usr_x', userType: 'member' } },
  onRequest: (req, res) => {
    const { phone, code } = req.body || {};
    const otp = otps.find(o => o.phone === phone);
    if (!otp || otp.code !== code) return res.status(401).json({ error: 'invalid_otp' });
    if (Date.now() > otp.expiresAt) return res.status(401).json({ error: 'otp_expired' });

    let user = users.find(u => u.phone === phone);
    if (!user) {
      user = {
        id: `usr_${randomUUID().slice(0, 8)}`,
        phone, userType: otp.userType, createdAt: new Date().toISOString()
      };
      users.insert(user);
    }
    otps.update(o => o.phone === phone, { code: null });
    const token = signJwt({ sub: user.id, userType: user.userType, phone: user.phone });
    res.json({ token, user });
  }
};

export const authLogin = {
  created, method: 'post', path: '/auth/login',
  description: 'Email+password login (operators & admins). Demo only — replace with bcrypt.',
  requestSample: { email: 'operator@iron-paradise.tz', password: 'operator123' },
  responseSample: { token: 'jwt...', user: { id: 'usr_op_1', userType: 'gym_operator' } },
  onRequest: (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });
    // Demo passwords blocked in production
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'demo_login_disabled_in_production' });
    }
    const user = users.find(u => u.email === email);
    if (!user || user.passwordHash !== `demo:${password}`)
      return res.status(401).json({ error: 'invalid_credentials' });
    // Block suspended accounts
    if (user.accountStatus === 'suspended')
      return res.status(403).json({ error: 'account_suspended' });
    const token = signJwt({ sub: user.id, userType: user.userType, gymId: user.gymId });
    res.json({ token, user });
  }
};

export const authFirebaseSession = {
  created, method: 'post', path: '/auth/firebase/session',
  description: 'Exchange a Firebase ID token for a FitFlex session. Firebase is identity only; FitFlex stores roles.',
  requestSample: { idToken: 'firebase-id-token', requestedRole: 'member' },
  responseSample: { token: 'jwt...', user: { id: 'usr_x', userType: 'member' } },
  onRequest: async (req, res) => {
    const { idToken, requestedRole = 'member' } = req.body || {};
    const fb = await verifyFirebaseIdToken(idToken);
    if (!fb) return res.status(401).json({ error: 'invalid_firebase_token' });

    const selfRole = normalizeRequestedRole(requestedRole);
    const isAdminEmail = isConfiguredAdminEmail(fb.email);
    let user = users.find(u => u.firebaseUid === fb.uid) || (fb.email ? users.find(u => u.email === fb.email) : null);

    if (user && !isAdminEmail && user.userType !== selfRole) {
      return res.status(409).json({
        error: 'email_already_used_for_different_role',
        existingRole: user.userType,
        requestedRole: selfRole
      });
    }

    if (!user) {
      user = {
        id: `usr_${randomUUID().slice(0, 8)}`,
        firebaseUid: fb.uid,
        email: fb.email,
        displayName: fb.name,
        photoUrl: fb.picture,
        userType: isAdminEmail ? 'admin' : selfRole,
        approvalStatus: isAdminEmail ? 'approved' : approvalStatusForRole(selfRole),
        createdAt: new Date().toISOString()
      };
      users.insert(user);
    } else {
      const patch = {
        firebaseUid: isAdminEmail ? fb.uid : (user.firebaseUid || fb.uid),
        email: user.email || fb.email,
        displayName: fb.name || user.displayName,
        photoUrl: fb.picture || user.photoUrl,
        approvalStatus: user.approvalStatus || 'approved',
        ...(isAdminEmail ? { userType: 'admin' } : {})
      };
      user = users.update(u => u.id === user.id, patch);
    }

    // Block suspended accounts
    if (user.accountStatus === 'suspended') {
      return res.status(403).json({ error: 'account_suspended' });
    }
    // Block rejected profiles (owners/trainers)
    if (user.approvalStatus === 'rejected') {
      return res.status(403).json({ error: 'profile_rejected', approvalNote: user.approvalNote || null });
    }

    const token = signJwt({
      sub: user.id,
      userType: user.userType,
      email: user.email,
      gymId: user.gymId
    });
    res.json({ token, user, pendingApproval: user.approvalStatus === 'pending_approval' });
  }
};

// ───────────────────────────────────────── Gyms ───────────────────────────────────────────
export const listGyms = {
  created, method: 'get', path: '/gyms',
  description: 'Public list of active gyms.',
  responseSample: [{ id: 'gym_001', name: 'Iron Paradise Masaki', tier: 'standard' }],
  onRequest: (_, res) => res.json(gyms.filter(g => g.status === 'active'))
};

export const getGym = {
  created, method: 'get', path: '/gyms/:id',
  description: 'Get a single gym',
  onRequest: (req, res) => {
    const g = gyms.find(x => x.id === req.params.id);
    if (!g) return res.status(404).json({ error: 'not_found' });
    res.json(g);
  }
};

export const adminUpsertGym = {
  created, method: 'post', path: '/admin/gyms',
  description: 'Admin: create or update a gym (tier set here only — audit logged).',
  requestSample: { id: 'gym_006', name: 'New Gym', tier: 'midtier', location: 'DSM', perVisitRate: 8000, commissionRate: 12 },
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const body = req.body || {};
    if (!body.name || !body.tier) return res.status(400).json({ error: 'name_and_tier_required' });
    const id = body.id || `gym_${randomUUID().slice(0, 6)}`;
    const prior = gyms.find(g => g.id === id);
    const row = normalizeGymPayload({ ...body, id }, prior);
    gyms.upsert(g => g.id === id, row);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub, action: prior ? 'gym_updated' : 'gym_created',
      target: id, before: prior ?? null, after: row
    });
    res.json(row);
  }
};

export const adminDeleteGym = {
  created, method: 'delete', path: '/admin/gyms/:id',
  description: 'Admin: delete a gym from the pilot catalogue.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const prior = gyms.find(g => g.id === req.params.id);
    if (!prior) return res.status(404).json({ error: 'not_found' });
    const assignedOperator = users.find(u => u.userType === 'gym_operator' && u.gymId === prior.id);
    const hasCheckins = checkins.find(c => c.gymId === prior.id);
    if (assignedOperator || hasCheckins) return res.status(409).json({ error: 'gym_has_activity_or_operator' });
    const removed = gyms.remove(g => g.id === prior.id);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub, action: 'gym_deleted',
      target: prior.id, before: prior, after: null
    });
    res.json({ ok: true, gym: removed });
  }
};

// ───────────────────────────────────────── Subscriptions ──────────────────────────────────
export const listPasses = {
  created, method: 'get', path: '/passes',
  description: 'Platform Pass tier catalogue (v2.0 prices).',
  onRequest: (_, res) => res.json(
    Object.entries(PASS_TIERS).map(([id, cfg]) => ({
      id, ...cfg,
      visitCap: Number.isFinite(cfg.visitCap) ? cfg.visitCap : null
    }))
  )
};

export const subscribe = {
  created, method: 'post', path: '/me/subscribe',
  description: 'Create a pilot Platform Pass payment request. Admin approval activates the subscription.',
  requestSample: { tier: 'pro', type: 'platform_pass' },
  onGuard: requireAuth('member'),
  onRequest: (req, res) => {
    const { tier, type = 'platform_pass', homeGymId } = req.body || {};
    if (type === 'platform_pass' && !PASS_TIERS[tier])
      return res.status(400).json({ error: 'invalid_tier' });
    const now = new Date();
    const renewsAt = new Date(+now + 30 * 86_400_000);
    const amountTzs = PASS_TIERS[tier]?.price;
    const isFreeOnline = amountTzs === 0 && PASS_TIERS[tier]?.accessMode === 'free_online';
    const sub = {
      id: `sub_${randomUUID().slice(0, 8)}`,
      memberId: req.user.sub,
      type, tier: type === 'platform_pass' ? tier : null,
      status: isFreeOnline ? 'active' : 'payment_pending',
      startedAt: now.toISOString(),
      cycleStartedAt: now.toISOString(),
      renewsAt: renewsAt.toISOString(),
      expiresAt: renewsAt.toISOString(),
      homeGymId: homeGymId ?? null,
      paymentRef: isFreeOnline ? 'FREE_ONLINE' : null,
      pilotPayment: true
    };
    subscriptions.insert(sub);
    if (isFreeOnline) {
      return res.status(201).json({ subscription: sub, paymentRequest: null });
    }
    const paymentRequest = paymentRequests.insert({
      id: `pay_${randomUUID().slice(0, 8)}`,
      memberId: req.user.sub,
      subscriptionId: sub.id,
      tier,
      amountTzs,
      status: 'pending',
      provider: 'admin_approved',
      reference: null,
      requestedAt: now.toISOString(),
      decidedAt: null,
      decidedBy: null,
      note: null
    });
    res.status(202).json({ subscription: sub, paymentRequest });
  }
};

export const me = {
  created, method: 'get', path: '/me',
  description: 'Authenticated user profile + active subscription + visit counter.',
  onGuard: requireAuth(),
  onRequest: (req, res) => {
    const user = users.find(u => u.id === req.user.sub);
    const subs = subscriptions.filter(s => s.memberId === req.user.sub);
    const sub  = subs
      .filter(s => ['active', 'expired', 'suspended'].includes(s.status))
      .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0] || null;
    const pendingPayment = paymentRequests
      .filter(p => p.memberId === req.user.sub && p.status === 'pending')
      .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt))[0] || null;
    let visitsUsed = 0, visitCap = null;
    if (sub) {
      const since = +new Date(sub.cycleStartedAt);
      visitsUsed = checkins.filter(c => c.memberId === user.id && c.visitConsumed && +new Date(c.timestamp) >= since).length;
      const cap = PASS_TIERS[sub.tier]?.visitCap;
      visitCap = Number.isFinite(cap) ? cap : null;
    }
    res.json({ user, subscription: sub, pendingPayment, visitsUsed, visitCap });
  }
};

export const updateMemberProfile = {
  created, method: 'post', path: '/me/profile',
  description: 'Member: save onboarding goals, personal details, workout times, and notification preferences.',
  onGuard: requireAuth('member'),
  onRequest: (req, res) => {
    const user = users.find(u => u.id === req.user.sub) || {
      id: req.user.sub,
      userType: 'member',
      createdAt: new Date().toISOString()
    };
    if (!users.find(u => u.id === user.id)) users.insert(user);
    const body = req.body || {};
    const memberProfile = {
      ...(user.memberProfile || {}),
      fitnessGoal: body.fitnessGoal ?? user.memberProfile?.fitnessGoal ?? null,
      fitnessLevel: body.fitnessLevel ?? user.memberProfile?.fitnessLevel ?? null,
      heightCm: body.heightCm ?? user.memberProfile?.heightCm ?? null,
      weightKg: body.weightKg ?? user.memberProfile?.weightKg ?? null,
      dateOfBirth: body.dateOfBirth ?? user.memberProfile?.dateOfBirth ?? null,
      gender: body.gender ?? user.memberProfile?.gender ?? null,
      preferredWorkoutTimes: Array.isArray(body.preferredWorkoutTimes)
        ? body.preferredWorkoutTimes
        : (user.memberProfile?.preferredWorkoutTimes || []),
      notificationPreferences: {
        ...(user.memberProfile?.notificationPreferences || {}),
        ...(body.notificationPreferences || {})
      }
    };
    const updated = users.update(u => u.id === user.id, {
      displayName: body.displayName ?? user.displayName,
      phone: body.phone ?? user.phone,
      onboardingCompleted: true,
      memberProfile
    });
    res.json({ user: updated });
  }
};

export const memberCheckIns = {
  created, method: 'get', path: '/me/checkins',
  description: 'Member: recent check-in history for profile and QR screens.',
  onGuard: requireAuth('member'),
  onRequest: (req, res) => {
    const list = checkins
      .filter(c => c.memberId === req.user.sub)
      .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
      .slice(0, 50)
      .map(c => ({ ...c, gym: gyms.find(g => g.id === c.gymId) || null }));
    res.json(list);
  }
};

export const listTrainers = {
  created, method: 'get', path: '/trainers',
  description: 'Public trainer discovery list.',
  onRequest: (req, res) => {
    const q = String(req.query?.q || '').toLowerCase();
    const specialty = String(req.query?.specialty || '').toLowerCase();
    const list = trainers
      .filter(t => t.status === 'active')
      .filter(t => !q || t.displayName.toLowerCase().includes(q) || t.specialties.join(' ').toLowerCase().includes(q))
      .filter(t => !specialty || t.specialties.some(s => s.toLowerCase().includes(specialty)))
      .map(hydrateTrainer);
    res.json(list);
  }
};

export const getTrainer = {
  created, method: 'get', path: '/trainers/:id',
  description: 'Public trainer profile detail.',
  onRequest: (req, res) => {
    const trainer = trainers.find(t => t.id === req.params.id && t.status === 'active');
    if (!trainer) return res.status(404).json({ error: 'not_found' });
    res.json(hydrateTrainer(trainer));
  }
};

export const adminListTrainers = {
  created, method: 'get', path: '/admin/trainers',
  description: 'Admin: list all trainer profiles with linked gyms.',
  onGuard: requireAuth('admin'),
  onRequest: (_, res) => {
    res.json(trainers.all().map(hydrateTrainer).sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || ''))));
  }
};

export const adminUpsertTrainer = {
  created, method: 'post', path: '/admin/trainers',
  description: 'Admin: create or update trainer profile data used by member discovery.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const body = req.body || {};
    if (!body.id && !body.displayName) return res.status(400).json({ error: 'displayName_required' });
    const id = body.id || `trn_${randomUUID().slice(0, 8)}`;
    const prior = trainers.find(t => t.id === id);
    const duplicateEmail = body.email && trainers.find(t => t.email === body.email && t.id !== id);
    if (duplicateEmail) return res.status(409).json({ error: 'email_already_used' });
    const row = normalizeTrainerPayload({ ...body, id }, prior || {});
    trainers.upsert(t => t.id === id, row);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub, action: prior ? 'trainer_updated' : 'trainer_created',
      target: id, before: prior ?? null, after: row
    });
    res.status(prior ? 200 : 201).json(row);
  }
};

export const adminDeleteTrainer = {
  created, method: 'delete', path: '/admin/trainers/:id',
  description: 'Admin: delete trainer profile if it has no bookings.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const prior = trainers.find(t => t.id === req.params.id);
    if (!prior) return res.status(404).json({ error: 'not_found' });
    if (trainerBookings.find(b => b.trainerId === prior.id)) return res.status(409).json({ error: 'trainer_has_bookings' });
    const removed = trainers.remove(t => t.id === prior.id);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub, action: 'trainer_deleted',
      target: prior.id, before: prior, after: null
    });
    res.json({ ok: true, trainer: removed });
  }
};

export const createTrainerBooking = {
  created, method: 'post', path: '/me/trainer-bookings',
  description: 'Member: book a trainer session. Pilot status is confirmed immediately.',
  onGuard: requireAuth('member'),
  onRequest: (req, res) => {
    const { trainerId, gymId, date, slot } = req.body || {};
    const trainer = trainers.find(t => t.id === trainerId && t.status === 'active');
    if (!trainer) return res.status(404).json({ error: 'trainer_not_found' });
    if (!trainer.gymIds?.includes(gymId)) return res.status(400).json({ error: 'trainer_not_available_at_gym' });
    if (!date || !slot) return res.status(400).json({ error: 'date_and_slot_required' });
    const booking = trainerBookings.insert({
      id: `tbk_${randomUUID().slice(0, 8)}`,
      memberId: req.user.sub,
      trainerId,
      gymId,
      date,
      slot,
      amountTzs: trainer.hourlyRateTzs,
      status: 'confirmed',
      createdAt: new Date().toISOString()
    });
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user.sub, action: 'trainer_booking_created',
      target: booking.id, before: null, after: booking
    });
    res.status(201).json({ booking, trainer: hydrateTrainer(trainer) });
  }
};

export const adminListTrainerBookings = {
  created, method: 'get', path: '/admin/trainer-bookings',
  description: 'Admin: list trainer sessions and booking status.',
  onGuard: requireAuth('admin'),
  onRequest: (_, res) => {
    const list = trainerBookings
      .all()
      .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0))
      .map(hydrateTrainerBooking);
    res.json(list);
  }
};

export const adminUpdateTrainerBooking = {
  created, method: 'post', path: '/admin/trainer-bookings/:id',
  description: 'Admin: update trainer booking status.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const { status } = req.body || {};
    if (!['confirmed', 'completed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
    const prior = trainerBookings.find(b => b.id === req.params.id);
    if (!prior) return res.status(404).json({ error: 'not_found' });
    const updated = trainerBookings.update(b => b.id === prior.id, { status, updatedAt: new Date().toISOString() });
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub, action: `trainer_booking_${status}`,
      target: prior.id, before: prior, after: updated
    });
    res.json(hydrateTrainerBooking(updated));
  }
};

// ───────────────────────────────────────── QR Check-in ────────────────────────────────────
export const myQr = {
  created, method: 'get', path: '/me/qr',
  description: 'Issue a 60-second rotating QR token for the authenticated member.',
  onGuard: requireAuth('member'),
  onRequest: (req, res) => {
    const active = subscriptions
      .filter(s => s.memberId === req.user.sub && s.status === 'active')
      .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0];
    if (!active) return res.status(403).json({ error: 'active_subscription_required' });
    res.json(issueQr(req.user.sub));
  }
};

export const operatorVerifyQr = {
  created, method: 'post', path: '/operator/verify-qr',
  description: 'Operator: verify a member QR and return member details + pass eligibility without check-in.',
  onGuard: requireAuth('gym_operator'),
  onRequest: (req, res) => {
    const { qrToken } = req.body || {};
    const claim = verifyQr(qrToken);
    if (!claim) return res.status(401).json({ ok: false, failure: 'invalid_or_expired_qr' });
    const operator = users.find(u => u.id === req.user.sub);
    if (!operator?.gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });
    const member = users.find(u => u.id === claim.userId);
    if (!member) return res.status(404).json({ error: 'member_not_found' });
    const gym = gyms.find(g => g.id === operator.gymId);
    const sub = subscriptions
      .filter(s => s.memberId === member.id && s.status === 'active')
      .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))[0] || null;
    let eligible = false;
    let reason = 'no_active_pass';
    let visitsUsed = 0;
    let visitCap = null;
    if (sub) {
      const tier = PASS_TIERS[sub.tier];
      const since = +new Date(sub.cycleStartedAt);
      visitsUsed = checkins.filter(c => c.memberId === member.id && c.visitConsumed && +new Date(c.timestamp) >= since).length;
      visitCap = Number.isFinite(tier?.visitCap) ? tier.visitCap : null;
      const gymAccess = tier?.gymAccess || [];
      const gymTier = gym?.tier || 'standard';
      if (!gymAccess.includes(gymTier)) {
        reason = 'gym_tier_not_covered';
      } else if (visitCap !== null && visitsUsed >= visitCap) {
        reason = 'visit_cap_reached';
      } else {
        eligible = true;
        reason = 'pass_valid';
      }
    }
    res.json({
      ok: true,
      member: { id: member.id, displayName: member.displayName, email: member.email, phone: member.phone, photoUrl: member.photoUrl },
      subscription: sub ? { tier: sub.tier, status: sub.status } : null,
      gym: gym ? { id: gym.id, name: gym.name, tier: gym.tier } : null,
      eligible,
      reason,
      visitsUsed,
      visitCap,
    });
  }
};

export const operatorCheckIn = {
  created, method: 'post', path: '/operator/checkins',
  description: 'Operator scans a member QR and triggers BL-012 validation + logging.',
  requestSample: { qrToken: 'usr_x.123456.signature' },
  onGuard: requireAuth('gym_operator'),
  onRequest: (req, res) => {
    const { qrToken } = req.body || {};
    const claim = verifyQr(qrToken);
    if (!claim) return res.status(401).json({ ok: false, failure: 'invalid_or_expired_qr' });
    const operator = users.find(u => u.id === req.user.sub);
    if (!operator?.gymId) return res.status(400).json({ error: 'operator_not_assigned_to_gym' });

    const result = checkInService.perform({
      memberId: claim.userId,
      gymId: operator.gymId,
      method: 'gym_scanned'
    });
    if (!result.ok) return res.status(409).json(result);
    res.json(result);
  }
};

export const operatorRecentCheckIns = {
  created, method: 'get', path: '/operator/checkins',
  description: 'List of recent check-ins at the operator gym.',
  onGuard: requireAuth('gym_operator'),
  onRequest: (req, res) => {
    const operator = users.find(u => u.id === req.user.sub);
    const list = checkins
      .filter(c => c.gymId === operator?.gymId)
      .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
      .slice(0, 50)
      .map(c => {
        const m = users.find(u => u.id === c.memberId);
        return { ...c, memberPhone: m?.phone ?? null, memberEmail: m?.email ?? null };
      });
    res.json(list);
  }
};

export const operatorDashboard = {
  created, method: 'get', path: '/operator/dashboard',
  description: 'Basic analytics for the operator gym (today visits, period total, current band).',
  onGuard: requireAuth('gym_operator'),
  onRequest: (req, res) => {
    const operator = users.find(u => u.id === req.user.sub);
    const gym = gyms.find(g => g.id === operator?.gymId);
    if (!gym) return res.status(404).json({ error: 'gym_not_found' });

    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const todayCount = checkins.filter(c => c.gymId === gym.id && +new Date(c.timestamp) >= +startOfDay).length;
    const monthVisits = checkins.filter(c => c.gymId === gym.id && +new Date(c.timestamp) >= +startOfMonth && c.subscriptionType === 'platform_pass').length;
    const payout = monthVisits >= 500
      ? { band: 5, note: 'Negotiate flat fee' }
      : calculatePayout({ visitCount: monthVisits, gymTier: gym.tier, negotiatedPerVisitRate: gym.perVisitRate });

    res.json({ gym, todayCount, monthVisits, payout });
  }
};

// ───────────────────────────────────────── Owner/Operator role APIs ──────────────────────

export const gymOwnerRegister = {
  created, method: 'post', path: '/gym-owner/register',
  description: 'Gym Owner: self-register with gym details. Creates one or more gyms and assigns to owner.',
  onGuard: requireAuth('gym_operator'),
  onRequest: (req, res) => {
    const body = req.body || {};
    const user = users.find(u => u.id === req.user.sub);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    const gymList = Array.isArray(body.gyms) ? body.gyms : [];
    if (gymList.length === 0) return res.status(400).json({ error: 'at_least_one_gym_required' });
    const createdGyms = [];
    const gymIds = [];
    for (const g of gymList) {
      const row = normalizeGymPayload(g, {});
      row.status = 'active';
      gyms.upsert(x => x.id === row.id, row);
      createdGyms.push(row);
      gymIds.push(row.id);
    }
    // Update owner user with gym assignments and mark onboarding done
    users.update(u => u.id === req.user.sub, {
      displayName: body.displayName || user.displayName,
      gymId: gymIds[0],
      gymIds,
      onboardingCompleted: true,
    });
    res.json({ gyms: createdGyms, gymIds });
  }
};

export const ownerMyGyms = {
  created, method: 'get', path: '/owner/gyms',
  description: 'Owner: list gyms assigned to the authenticated owner.',
  onGuard: requireAuth('gym_operator'),
  onRequest: (req, res) => {
    const owner = users.find(u => u.id === req.user.sub);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const ids = owner.gymIds || (owner.gymId ? [owner.gymId] : []);
    const owned = ids.map(id => gyms.find(g => g.id === id)).filter(Boolean);
    res.json(owned);
  }
};

export const ownerMyInvoices = {
  created, method: 'get', path: '/owner/invoices',
  description: 'Owner: list invoices for their gyms.',
  onGuard: requireAuth('gym_operator'),
  onRequest: (req, res) => {
    const owner = users.find(u => u.id === req.user.sub);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const ids = owner.gymIds || (owner.gymId ? [owner.gymId] : []);
    const allInv = invoices.filter(i => ids.includes(i.gymId));
    allInv.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    res.json(allInv);
  }
};

export const ownerMyEarnings = {
  created, method: 'get', path: '/owner/earnings',
  description: 'Owner: summary of earnings (paid invoices) for their gyms.',
  onGuard: requireAuth('gym_operator'),
  onRequest: (req, res) => {
    const owner = users.find(u => u.id === req.user.sub);
    if (!owner) return res.status(404).json({ error: 'user_not_found' });
    const ids = owner.gymIds || (owner.gymId ? [owner.gymId] : []);
    const paid = invoices.filter(i => ids.includes(i.gymId) && i.status === 'paid');
    const totalPaid = paid.reduce((s, i) => s + (i.amount || 0), 0);
    const pending = invoices.filter(i => ids.includes(i.gymId) && i.status === 'unpaid');
    const totalPending = pending.reduce((s, i) => s + (i.amount || 0), 0);
    res.json({ totalPaid, totalPending, paidCount: paid.length, pendingCount: pending.length });
  }
};

export const ownerGymCheckins = {
  created, method: 'get', path: '/owner/gyms/:gymId/checkins',
  description: 'Owner: recent check-ins at a specific owned gym.',
  onGuard: requireAuth('gym_operator'),
  onRequest: (req, res) => {
    const owner = users.find(u => u.id === req.user.sub);
    const ids = owner?.gymIds || (owner?.gymId ? [owner.gymId] : []);
    if (!ids.includes(req.params.gymId)) return res.status(403).json({ error: 'not_your_gym' });
    const list = checkins
      .filter(c => c.gymId === req.params.gymId)
      .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
      .slice(0, 100)
      .map(c => {
        const m = users.find(u => u.id === c.memberId);
        return { ...c, memberName: m?.displayName || m?.email || c.memberId };
      });
    res.json(list);
  }
};

export const ownerUpdateGym = {
  created, method: 'put', path: '/owner/gyms/:gymId',
  description: 'Owner: update details of an owned gym.',
  onGuard: requireAuth('gym_operator'),
  onRequest: (req, res) => {
    const owner = users.find(u => u.id === req.user.sub);
    const ids = owner?.gymIds || (owner?.gymId ? [owner.gymId] : []);
    if (!ids.includes(req.params.gymId)) return res.status(403).json({ error: 'not_your_gym' });
    const prior = gyms.find(g => g.id === req.params.gymId);
    if (!prior) return res.status(404).json({ error: 'gym_not_found' });
    const body = req.body || {};
    const row = normalizeGymPayload({ ...body, id: prior.id }, prior);
    row.status = prior.status; // owner can't change status
    gyms.upsert(g => g.id === row.id, row);
    res.json(row);
  }
};

export const ownerAddTrainer = {
  created, method: 'post', path: '/owner/trainers',
  description: 'Owner: add a trainer to their gym(s). Trainer becomes auto-active. Email must be unique per user type.',
  onGuard: requireAuth('gym_operator'),
  onRequest: (req, res) => {
    const owner = users.find(u => u.id === req.user.sub);
    const ownerGymIds = owner?.gymIds || (owner?.gymId ? [owner.gymId] : []);
    const body = req.body || {};
    if (!body.email) return res.status(400).json({ error: 'email_required' });
    if (!body.displayName) return res.status(400).json({ error: 'displayName_required' });
    const gymIds = parseStringList(body.gymIds, []).filter(id => ownerGymIds.includes(id));
    if (gymIds.length === 0) return res.status(400).json({ error: 'must_assign_to_at_least_one_owned_gym' });

    // Unique email per user type check
    const existingUser = users.find(u => u.email === body.email && u.userType === 'trainer');
    const existingTrainer = trainers.find(t => t.email === body.email);
    if (existingUser || existingTrainer) return res.status(409).json({ error: 'email_already_used_for_trainer' });

    // Create trainer profile (auto-active, auto-approved)
    const row = normalizeTrainerPayload({
      ...body,
      gymIds,
      status: 'active',
      approvalStatus: 'approved',
    }, {});
    trainers.upsert(t => t.id === row.id, row);
    res.json(hydrateTrainer(row));
  }
};

export const ownerListTrainers = {
  created, method: 'get', path: '/owner/trainers',
  description: 'Owner: list trainers assigned to their gyms.',
  onGuard: requireAuth('gym_operator'),
  onRequest: (req, res) => {
    const owner = users.find(u => u.id === req.user.sub);
    const ownerGymIds = owner?.gymIds || (owner?.gymId ? [owner.gymId] : []);
    const list = trainers.filter(t => {
      const tGymIds = t.gymIds || [];
      return tGymIds.some(id => ownerGymIds.includes(id));
    }).map(hydrateTrainer);
    res.json(list);
  }
};

// ───────────────────────────────────────── Trainer role APIs ─────────────────────────────

export const trainerRegister = {
  created, method: 'post', path: '/trainer/register',
  description: 'Trainer: self-register full profile (displayName, specialties, bio, hourlyRate, experience, availability). Creates trainer profile if missing.',
  onGuard: requireAuth('trainer'),
  onRequest: (req, res) => {
    const body = req.body || {};
    const user = users.find(u => u.id === req.user.sub);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    let profile = trainers.find(t => t.userId === req.user.sub || t.id === req.user.sub);
    const row = normalizeTrainerPayload({
      ...body,
      id: profile?.id || undefined,
      userId: req.user.sub,
      email: user.email,
      displayName: body.displayName || user.displayName,
      photoUrl: body.photoUrl || user.photoUrl,
      status: 'active',
      approvalStatus: 'pending_approval',
    }, profile || {});
    trainers.upsert(t => t.id === row.id, row);
    // Mark user onboarding as complete
    users.update(u => u.id === req.user.sub, {
      displayName: body.displayName || user.displayName,
      onboardingCompleted: true,
    });
    res.json(hydrateTrainer(row));
  }
};

export const trainerMyProfile = {
  created, method: 'get', path: '/trainer/me',
  description: 'Trainer: get own profile and linked gyms.',
  onGuard: requireAuth('trainer'),
  onRequest: (req, res) => {
    const profile = trainers.find(t => t.userId === req.user.sub || t.id === req.user.sub);
    if (!profile) return res.status(404).json({ error: 'trainer_profile_not_found' });
    res.json(hydrateTrainer(profile));
  }
};

export const trainerUpdateProfile = {
  created, method: 'put', path: '/trainer/me',
  description: 'Trainer: update own bio, specialties, hourly rate, availability.',
  onGuard: requireAuth('trainer'),
  onRequest: (req, res) => {
    const profile = trainers.find(t => t.userId === req.user.sub || t.id === req.user.sub);
    if (!profile) return res.status(404).json({ error: 'trainer_profile_not_found' });
    const body = req.body || {};
    const allowed = ['bio', 'specialties', 'hourlyRateTzs', 'experienceYears', 'availability', 'photoUrl'];
    const updates = {};
    for (const k of allowed) {
      if (body[k] !== undefined) updates[k] = body[k];
    }
    if (body.specialties) updates.specialties = parseStringList(body.specialties, profile.specialties);
    updates.updatedAt = new Date().toISOString();
    const updated = trainers.update(t => t.id === profile.id, updates);
    res.json(hydrateTrainer(updated));
  }
};

export const trainerMyBookings = {
  created, method: 'get', path: '/trainer/bookings',
  description: 'Trainer: list bookings assigned to this trainer.',
  onGuard: requireAuth('trainer'),
  onRequest: (req, res) => {
    const profile = trainers.find(t => t.userId === req.user.sub || t.id === req.user.sub);
    if (!profile) return res.status(404).json({ error: 'trainer_profile_not_found' });
    const bookings = trainerBookings
      .filter(b => b.trainerId === profile.id)
      .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0))
      .map(hydrateTrainerBooking);
    res.json(bookings);
  }
};

export const trainerCompleteBooking = {
  created, method: 'post', path: '/trainer/bookings/:id/complete',
  description: 'Trainer: mark a booking as completed.',
  onGuard: requireAuth('trainer'),
  onRequest: (req, res) => {
    const profile = trainers.find(t => t.userId === req.user.sub || t.id === req.user.sub);
    if (!profile) return res.status(404).json({ error: 'trainer_profile_not_found' });
    const booking = trainerBookings.find(b => b.id === req.params.id && b.trainerId === profile.id);
    if (!booking) return res.status(404).json({ error: 'booking_not_found' });
    if (booking.status !== 'confirmed') return res.status(409).json({ error: 'booking_not_confirmable' });
    const updated = trainerBookings.update(b => b.id === booking.id, { status: 'completed', updatedAt: new Date().toISOString() });
    res.json(hydrateTrainerBooking(updated));
  }
};

// ───────────────────────────────────────── Member extras ─────────────────────────────────

export const memberMyBookings = {
  created, method: 'get', path: '/me/trainer-bookings',
  description: 'Member: list own trainer bookings.',
  onGuard: requireAuth('member'),
  onRequest: (req, res) => {
    const bookings = trainerBookings
      .filter(b => b.memberId === req.user.sub)
      .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0))
      .map(hydrateTrainerBooking);
    res.json(bookings);
  }
};

export const memberPaymentHistory = {
  created, method: 'get', path: '/me/payments',
  description: 'Member: list own payment requests.',
  onGuard: requireAuth('member'),
  onRequest: (req, res) => {
    const list = paymentRequests
      .filter(p => p.memberId === req.user.sub)
      .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt));
    res.json(list);
  }
};

// ───────────────────────────────────────── Admin portal ──────────────────────────────────
export const adminListGyms = {
  created, method: 'get', path: '/admin/gyms',
  description: 'Admin: list gyms.',
  onGuard: requireAuth('admin'),
  onRequest: (_, res) => res.json(gyms.all())
};

export const adminPaymentRequests = {
  created, method: 'get', path: '/admin/payment-requests',
  description: 'Admin: list pilot payment requests.',
  onGuard: requireAuth('admin'),
  onRequest: (_, res) => {
    const list = paymentRequests.all()
      .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt))
      .map(p => ({
        ...p,
        member: users.find(u => u.id === p.memberId) || null,
        subscription: subscriptions.find(s => s.id === p.subscriptionId) || null
      }));
    res.json(list);
  }
};

export const adminDecidePaymentRequest = {
  created, method: 'post', path: '/admin/payment-requests/:id/decision',
  description: 'Admin: approve or reject a pilot payment request. Approval activates the subscription.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const { decision, reference, note } = req.body || {};
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'invalid_decision' });
    const request = paymentRequests.find(p => p.id === req.params.id);
    if (!request) return res.status(404).json({ error: 'not_found' });
    if (request.status !== 'pending') return res.status(409).json({ error: 'already_decided' });

    const now = new Date().toISOString();
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const updated = paymentRequests.update(p => p.id === request.id, {
      status,
      reference: reference || request.reference,
      note: note || null,
      decidedAt: now,
      decidedBy: req.user.sub
    });
    const subStatus = decision === 'approve' ? 'active' : 'payment_rejected';
    subscriptions.update(s => s.id === request.subscriptionId, {
      status: subStatus,
      paymentRef: reference || `ADMIN_${request.id}`
    });
    auditLog.insert({
      id: randomUUID(),
      at: now,
      actor: req.user.sub,
      action: `payment_${status}`,
      target: request.id,
      before: request,
      after: updated
    });
    res.json(updated);
  }
};

export const adminUpdatePaymentRequest = {
  created, method: 'post', path: '/admin/payment-requests/:id',
  description: 'Admin: update pilot payment request status, reference, and note.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const { status, reference, note } = req.body || {};
    const allowed = ['pending', 'approved', 'rejected', 'cancelled'];
    if (status && !allowed.includes(status)) return res.status(400).json({ error: 'invalid_status' });
    const request = paymentRequests.find(p => p.id === req.params.id);
    if (!request) return res.status(404).json({ error: 'not_found' });
    const nextStatus = status || request.status;
    const now = new Date().toISOString();
    const updated = paymentRequests.update(p => p.id === request.id, {
      status: nextStatus,
      reference: reference ?? request.reference,
      note: note ?? request.note ?? null,
      decidedAt: nextStatus === 'pending' ? null : (request.decidedAt || now),
      decidedBy: nextStatus === 'pending' ? null : req.user.sub
    });
    applyPaymentStatusToSubscription(request, nextStatus, reference ?? request.reference);
    auditLog.insert({
      id: randomUUID(), at: now,
      actor: req.user.sub,
      action: 'payment_updated',
      target: request.id,
      before: request,
      after: updated
    });
    res.json(updated);
  }
};

export const adminMembers = {
  created, method: 'get', path: '/admin/members',
  description: 'Admin: members and their latest subscription/payment state.',
  onGuard: requireAuth('admin'),
  onRequest: (_, res) => {
    const list = users.filter(u => u.userType === 'member').map(u => ({
      ...u,
      accountStatus: u.accountStatus || 'active',
      subscription: latestMemberSubscription(u.id),
      pendingPayment: paymentRequests
        .filter(p => p.memberId === u.id && p.status === 'pending')
        .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt))[0] || null
    }));
    res.json(list);
  }
};

export const adminUpsertMember = {
  created, method: 'post', path: '/admin/members',
  description: 'Admin: create or update a member profile.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const body = req.body || {};
    if (!body.id && !body.email && !body.phone) return res.status(400).json({ error: 'email_or_phone_required' });
    const id = body.id || `usr_${randomUUID().slice(0, 8)}`;
    const prior = users.find(u => u.id === id);
    if (body.email && !body.id) {
      const dup = users.find(u => u.email === body.email && u.id !== id);
      if (dup) return res.status(409).json({ error: 'email_already_used', existingRole: dup.userType });
    }
    const priorProfile = prior?.memberProfile || {};
    const memberProfile = {
      fitnessGoal: body.memberProfile?.fitnessGoal ?? priorProfile.fitnessGoal ?? null,
      fitnessLevel: body.memberProfile?.fitnessLevel ?? priorProfile.fitnessLevel ?? null,
      heightCm: body.memberProfile?.heightCm ?? priorProfile.heightCm ?? null,
      weightKg: body.memberProfile?.weightKg ?? priorProfile.weightKg ?? null,
      dateOfBirth: body.memberProfile?.dateOfBirth ?? priorProfile.dateOfBirth ?? null,
      gender: body.memberProfile?.gender ?? priorProfile.gender ?? null,
      preferredWorkoutTimes: Array.isArray(body.memberProfile?.preferredWorkoutTimes)
        ? body.memberProfile.preferredWorkoutTimes
        : (priorProfile.preferredWorkoutTimes || [])
    };
    const row = {
      id,
      userType: 'member',
      email: body.email ?? prior?.email ?? null,
      phone: body.phone ?? prior?.phone ?? null,
      displayName: body.displayName ?? prior?.displayName ?? null,
      photoUrl: body.photoUrl ?? prior?.photoUrl ?? null,
      accountStatus: body.accountStatus ?? prior?.accountStatus ?? 'active',
      memberProfile,
      createdAt: prior?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    users.upsert(u => u.id === id, row);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub, action: prior ? 'member_updated' : 'member_created',
      target: id, before: prior ?? null, after: row
    });
    const enriched = {
      ...row,
      subscription: latestMemberSubscription(id),
      pendingPayment: paymentRequests
        .filter(p => p.memberId === id && p.status === 'pending')
        .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt))[0] || null
    };
    res.status(prior ? 200 : 201).json(enriched);
  }
};

export const adminMemberPayments = {
  created, method: 'get', path: '/admin/members/:id/payments',
  description: 'Admin: get all payment requests for a specific member.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const memberId = req.params.id;
    const list = paymentRequests
      .filter(p => p.memberId === memberId)
      .sort((a, b) => +new Date(b.requestedAt) - +new Date(a.requestedAt));
    res.json(list);
  }
};

export const adminMemberCheckins = {
  created, method: 'get', path: '/admin/members/:id/checkins',
  description: 'Admin: visit history for a specific member, with optional ?from=&to= date range.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const memberId = req.params.id;
    const from = req.query?.from ? +new Date(req.query.from + 'T00:00:00Z') : 0;
    const to = req.query?.to ? +new Date(req.query.to + 'T23:59:59Z') : Date.now();
    const list = checkins
      .filter(c => c.memberId === memberId)
      .filter(c => { const ts = +new Date(c.timestamp); return ts >= from && ts <= to; })
      .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
      .map(c => ({ ...c, gym: gyms.find(g => g.id === c.gymId) || null }));
    res.json(list);
  }
};

export const adminSetMemberStatus = {
  created, method: 'post', path: '/admin/members/:id/status',
  description: 'Admin: activate or suspend a member and latest subscription.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const { status } = req.body || {};
    if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
    const member = users.find(u => u.id === req.params.id && u.userType === 'member');
    if (!member) return res.status(404).json({ error: 'not_found' });
    const before = { ...member, subscription: latestMemberSubscription(member.id) };
    const updatedUser = users.update(u => u.id === member.id, { accountStatus: status });
    const sub = latestMemberSubscription(member.id);
    let updatedSub = sub;
    if (sub) {
      updatedSub = subscriptions.update(s => s.id === sub.id, {
        status: status === 'suspended' ? 'suspended' : (sub.status === 'suspended' ? 'active' : sub.status)
      });
    }
    const after = { ...updatedUser, subscription: updatedSub };
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user.sub,
      action: `member_${status}`,
      target: member.id,
      before,
      after
    });
    res.json(after);
  }
};

export const adminListGymOwners = {
  created, method: 'get', path: '/admin/gym-owners',
  description: 'Admin: list gym owner/operator profiles with assigned gym.',
  onGuard: requireAuth('admin'),
  onRequest: (_, res) => {
    const list = users
      .filter(u => u.userType === 'gym_operator')
      .map(hydrateGymOwner)
      .sort((a, b) => String(a.displayName || a.email || '').localeCompare(String(b.displayName || b.email || '')));
    res.json(list);
  }
};

export const adminUpsertGymOwner = {
  created, method: 'post', path: '/admin/gym-owners',
  description: 'Admin: create or update gym owner profile and gym assignment.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const body = req.body || {};
    if (!body.id && !body.email) return res.status(400).json({ error: 'email_required' });
    if (body.gymId && !gyms.find(g => g.id === body.gymId)) return res.status(400).json({ error: 'gym_not_found' });
    const id = body.id || `usr_${randomUUID().slice(0, 8)}`;
    const prior = users.find(u => u.id === id);
    const duplicateEmail = body.email && users.find(u => u.email === body.email && u.id !== id);
    if (duplicateEmail) {
      return res.status(409).json({
        error: 'email_already_used',
        existingRole: duplicateEmail.userType
      });
    }
    const row = {
      id,
      userType: 'gym_operator',
      email: body.email ?? prior?.email,
      displayName: body.displayName ?? prior?.displayName ?? null,
      photoUrl: body.photoUrl ?? prior?.photoUrl ?? null,
      gymId: body.gymId ?? prior?.gymId ?? null,
      accountStatus: body.accountStatus ?? prior?.accountStatus ?? 'active',
      approvalStatus: body.approvalStatus ?? prior?.approvalStatus ?? 'approved',
      createdAt: prior?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    users.upsert(u => u.id === id, row);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub, action: prior ? 'gym_owner_updated' : 'gym_owner_created',
      target: id, before: prior ?? null, after: row
    });
    res.status(prior ? 200 : 201).json(hydrateGymOwner(row));
  }
};

export const adminDeleteGymOwner = {
  created, method: 'delete', path: '/admin/gym-owners/:id',
  description: 'Admin: delete a gym owner/operator profile if it has no check-in activity.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const prior = users.find(u => u.id === req.params.id && u.userType === 'gym_operator');
    if (!prior) return res.status(404).json({ error: 'not_found' });
    if (prior.gymId && checkins.find(c => c.gymId === prior.gymId)) return res.status(409).json({ error: 'gym_owner_has_checkin_activity' });
    const removed = users.remove(u => u.id === prior.id);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user?.sub, action: 'gym_owner_deleted',
      target: prior.id, before: prior, after: null
    });
    res.json({ ok: true, owner: removed });
  }
};

export const adminRoleApprovals = {
  created, method: 'get', path: '/admin/role-approvals',
  description: 'Admin: list gym owner and trainer profiles waiting for approval.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const status = req.query?.status || 'pending_approval';
    const list = users
      .filter(u => ['gym_operator', 'trainer'].includes(u.userType))
      .filter(u => status === 'all' || (u.approvalStatus || 'approved') === status)
      .sort((a, b) => +new Date(b.createdAt || 0) - +new Date(a.createdAt || 0));
    res.json(list);
  }
};

export const adminDecideRoleApproval = {
  created, method: 'post', path: '/admin/role-approvals/:id/decision',
  description: 'Admin: approve or reject a pending gym owner or trainer profile.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const { decision, note } = req.body || {};
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'invalid_decision' });
    const target = users.find(u => u.id === req.params.id && ['gym_operator', 'trainer'].includes(u.userType));
    if (!target) return res.status(404).json({ error: 'not_found' });
    const before = { ...target };
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const updated = users.update(u => u.id === target.id, {
      approvalStatus: status,
      approvalNote: note ?? null,
      approvedAt: status === 'approved' ? new Date().toISOString() : null,
      approvedBy: status === 'approved' ? req.user.sub : null
    });
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user.sub, action: `role_${status}`,
      target: target.id, before, after: updated
    });
    res.json(updated);
  }
};

// ───────────────────────────────────────── Gym Usage & Payment Distribution ────────────────

/**
 * Smart billing rate logic:
 * - Count consecutive day streaks per member per gym
 * - 4–7 consecutive days → bill at week rate
 * - 3+ consecutive weeks (in a calendar month) → bill at month rate
 * - Otherwise → bill at day rate
 */
function computeGymUsageSummaries() {
  const allGyms = gyms.filter(() => true);
  const allCheckins = checkins.filter(() => true);
  const gymPayoutsCol = collection('gym_payouts');
  const summaries = [];

  for (const gym of allGyms) {
    const gymCheckins = allCheckins.filter(c => c.gymId === gym.id);
    if (gymCheckins.length === 0) {
      summaries.push({
        gymId: gym.id, gymName: gym.name, location: gym.location || '',
        totalVisits: 0, uniqueMembers: 0, dayVisits: 0, weekVisits: 0, monthVisits: 0,
        totalOwed: 0, totalPaid: 0, balance: 0
      });
      continue;
    }

    const rateDay = gym.ratePerDay ?? gym.perVisitRate ?? 0;
    const rateWeek = gym.ratePerWeek ?? rateDay * 5;
    const rateMonth = gym.ratePerMonth ?? rateWeek * 3;

    // Group checkins by member
    const byMember = {};
    for (const c of gymCheckins) {
      if (!byMember[c.memberId]) byMember[c.memberId] = [];
      byMember[c.memberId].push(c.timestamp);
    }

    let totalOwed = 0;
    let dayCount = 0, weekCount = 0, monthCount = 0;
    const uniqueMembers = new Set();

    for (const [memberId, timestamps] of Object.entries(byMember)) {
      uniqueMembers.add(memberId);
      // Get unique visit dates (EAT)
      const dates = [...new Set(timestamps.map(ts => {
        const d = new Date(new Date(ts).getTime() + 3 * 3_600_000);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      }))].sort();

      // Find consecutive streaks
      const streaks = [];
      let streak = [dates[0]];
      for (let i = 1; i < dates.length; i++) {
        const prev = new Date(dates[i - 1]);
        const curr = new Date(dates[i]);
        const diff = (curr - prev) / 86_400_000;
        if (diff === 1) {
          streak.push(dates[i]);
        } else {
          streaks.push(streak);
          streak = [dates[i]];
        }
      }
      streaks.push(streak);

      // Group streaks by month
      const monthStreaks = {};
      for (const s of streaks) {
        const monthKey = s[0].slice(0, 7); // YYYY-MM
        if (!monthStreaks[monthKey]) monthStreaks[monthKey] = [];
        monthStreaks[monthKey].push(s);
      }

      // Determine billing per month
      for (const [, mStreaks] of Object.entries(monthStreaks)) {
        const weekStreakCount = mStreaks.filter(s => s.length >= 4).length;

        if (weekStreakCount >= 3) {
          // 3+ week-length streaks in a month → bill month rate
          totalOwed += rateMonth;
          monthCount += 1;
        } else {
          for (const s of mStreaks) {
            if (s.length >= 4 && s.length <= 7) {
              totalOwed += rateWeek;
              weekCount += 1;
            } else if (s.length > 7) {
              // More than a week but not enough for month — multiple weeks
              const weeks = Math.floor(s.length / 7);
              const remainDays = s.length % 7;
              totalOwed += weeks * rateWeek;
              weekCount += weeks;
              if (remainDays >= 4) {
                totalOwed += rateWeek;
                weekCount += 1;
              } else {
                totalOwed += remainDays * rateDay;
                dayCount += remainDays;
              }
            } else {
              totalOwed += s.length * rateDay;
              dayCount += s.length;
            }
          }
        }
      }
    }

    const paid = gymPayoutsCol
      .filter(p => p.gymId === gym.id && p.status === 'paid')
      .reduce((sum, p) => sum + (p.amount || 0), 0);

    summaries.push({
      gymId: gym.id, gymName: gym.name, location: gym.location || '',
      totalVisits: gymCheckins.length, uniqueMembers: uniqueMembers.size,
      dayVisits: dayCount, weekVisits: weekCount, monthVisits: monthCount,
      totalOwed: Math.round(totalOwed), totalPaid: paid,
      balance: Math.round(totalOwed) - paid
    });
  }
  return summaries;
}

export const adminGymUsage = {
  created, method: 'get', path: '/admin/gym-usage',
  description: 'Admin: gym usage summary with smart day/week/month billing calculation.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    res.json(computeGymUsageSummaries());
  }
};

export const adminGymVisitDetails = {
  created, method: 'get', path: '/admin/gym-usage/:gymId/visits',
  description: 'Admin: detailed visit records for a specific gym with billing type per visit.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const gym = gyms.find(g => g.id === req.params.gymId);
    if (!gym) return res.status(404).json({ error: 'gym_not_found' });

    const gymCheckins = checkins
      .filter(c => c.gymId === gym.id)
      .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp));

    const rateDay = gym.ratePerDay ?? gym.perVisitRate ?? 0;
    const rateWeek = gym.ratePerWeek ?? rateDay * 5;
    const rateMonth = gym.ratePerMonth ?? rateWeek * 3;

    const records = gymCheckins.map(c => {
      const member = users.find(u => u.id === c.memberId);
      return {
        gymId: gym.id,
        gymName: gym.name,
        memberId: c.memberId,
        memberName: member?.displayName || null,
        memberEmail: member?.email || null,
        date: c.timestamp,
        billingType: 'day',
        rate: rateDay
      };
    });
    res.json(records);
  }
};

// ───────────────────────────────────────── Period-based Distribution ─────────────────────

/**
 * Build payment periods from the earliest checkin to now, each `periodDays` long.
 * Returns an array of { start, end } date strings (YYYY-MM-DD).
 */
function buildPeriods(periodDays) {
  const allCk = checkins.filter(() => true);
  if (allCk.length === 0) return [];
  const earliest = allCk.reduce((m, c) => {
    const d = new Date(c.timestamp);
    return d < m ? d : m;
  }, new Date());
  earliest.setUTCHours(0, 0, 0, 0);
  const now = new Date();
  now.setUTCHours(23, 59, 59, 999);
  const periods = [];
  let cursor = new Date(earliest);
  while (cursor <= now) {
    const end = new Date(cursor.getTime() + periodDays * 86_400_000 - 1);
    const fmt = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    periods.push({ start: fmt(cursor), end: fmt(end > now ? now : end) });
    cursor = new Date(cursor.getTime() + periodDays * 86_400_000);
  }
  return periods;
}

export const adminPeriodDistribution = {
  created, method: 'get', path: '/admin/distributions/periods',
  description: 'Admin: period-based distribution — usage per gym per period with auto-generated invoices.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const settings = ensureDefaultSettings();
    const periodDays = settings.paymentPeriodDays || 14;
    const periods = buildPeriods(periodDays);
    const allGyms = gyms.filter(() => true);
    const allCheckins = checkins.filter(() => true);
    const gymPayoutsCol = collection('gym_payouts');
    const allInvoices = invoices.filter(() => true);

    const result = periods.map(period => {
      const pStart = new Date(period.start + 'T00:00:00Z');
      const pEnd = new Date(period.end + 'T23:59:59Z');

      // Filter checkins for this period
      const periodCheckins = allCheckins.filter(c => {
        const d = new Date(c.timestamp);
        return d >= pStart && d <= pEnd;
      });

      // Per-gym breakdown
      const gymBreakdowns = [];
      for (const gym of allGyms) {
        const gymCk = periodCheckins.filter(c => c.gymId === gym.id);
        if (gymCk.length === 0) continue;

        const rateDay = gym.ratePerDay ?? gym.perVisitRate ?? 0;
        const rateWeek = gym.ratePerWeek ?? rateDay * 5;
        const rateMonth = gym.ratePerMonth ?? rateWeek * 3;

        // Per-member detail
        const byMember = {};
        for (const c of gymCk) {
          if (!byMember[c.memberId]) byMember[c.memberId] = [];
          byMember[c.memberId].push(c.timestamp);
        }

        let gymOwed = 0;
        const memberDetails = [];

        for (const [memberId, timestamps] of Object.entries(byMember)) {
          const dates = [...new Set(timestamps.map(ts => {
            const d = new Date(new Date(ts).getTime() + 3 * 3_600_000);
            return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
          }))].sort();

          const member = users.find(u => u.id === memberId);
          let memberOwed = dates.length * rateDay;
          let billingType = 'day';

          if (dates.length >= 4 && dates.length <= 7) {
            memberOwed = rateWeek;
            billingType = 'week';
          } else if (dates.length > 7) {
            const weeks = Math.floor(dates.length / 7);
            const rem = dates.length % 7;
            memberOwed = weeks * rateWeek + (rem >= 4 ? rateWeek : rem * rateDay);
            billingType = 'week';
          }

          gymOwed += memberOwed;
          memberDetails.push({
            memberId,
            memberName: member?.displayName || member?.email || memberId,
            visitCount: dates.length,
            billingType,
            amount: Math.round(memberOwed),
          });
        }

        // Find or auto-create invoice for this period+gym
        let invoice = allInvoices.find(i =>
          i.gymId === gym.id && i.periodStart === period.start && i.periodEnd === period.end
        );
        if (!invoice && gymOwed > 0) {
          // Find owner
          const ownerCol = collection('gym_owners');
          const owner = ownerCol.find(o => o.gymId === gym.id || (o.gymIds && o.gymIds.includes(gym.id)));
          invoice = {
            id: randomUUID(),
            gymId: gym.id,
            gymName: gym.name,
            ownerId: owner?.id || null,
            ownerName: owner?.displayName || owner?.email || null,
            amount: Math.round(gymOwed),
            status: 'unpaid',
            note: `Auto-generated for period ${period.start} — ${period.end}`,
            periodStart: period.start,
            periodEnd: period.end,
            receiptUrl: null,
            paymentReference: null,
            createdAt: new Date().toISOString(),
            createdBy: 'system',
            paidAt: null,
          };
          invoices.insert(invoice);
          allInvoices.push(invoice);
        }

        // Determine paid amount: if invoice exists and is paid, paid = full amount
        const invoicePaid = invoice && invoice.status === 'paid';
        const paid = invoicePaid ? Math.round(gymOwed) : 0;

        gymBreakdowns.push({
          gymId: gym.id,
          gymName: gym.name,
          location: gym.location || '',
          totalVisits: gymCk.length,
          uniqueMembers: Object.keys(byMember).length,
          totalOwed: Math.round(gymOwed),
          totalPaid: paid,
          balance: Math.round(gymOwed) - paid,
          members: memberDetails,
          invoice: invoice || null,
        });
      }

      return {
        periodStart: period.start,
        periodEnd: period.end,
        periodDays,
        gyms: gymBreakdowns,
        totalOwed: gymBreakdowns.reduce((s, g) => s + g.totalOwed, 0),
        totalPaid: gymBreakdowns.reduce((s, g) => s + g.totalPaid, 0),
        balance: gymBreakdowns.reduce((s, g) => s + g.balance, 0),
      };
    });

    res.json(result.reverse()); // newest first
  }
};

// ───────────────────────────────────────── Book Keeping ────────────────────────────────────

export const adminBookKeeping = {
  created, method: 'get', path: '/admin/book-keeping',
  description: 'Admin: book keeping — money in (subscriptions) vs money out (gym payouts).',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const entries = [];

    // Money IN — approved payment requests (subscription payments)
    const approvedPayments = paymentRequests.filter(p => p.status === 'approved');
    for (const p of approvedPayments) {
      const member = users.find(u => u.id === p.memberId);
      entries.push({
        id: p.id,
        date: p.decidedAt || p.requestedAt,
        type: 'income',
        category: 'subscription',
        description: `${p.tier?.toUpperCase() || 'Pass'} subscription — ${member?.displayName || member?.email || p.memberId}`,
        amount: p.amountTzs || 0,
        reference: p.reference,
        memberId: p.memberId
      });
    }

    // Money OUT — only actually paid invoices count as outflow
    const paidInvoices = invoices.filter(i => i.status === 'paid');
    for (const inv of paidInvoices) {
      entries.push({
        id: inv.id,
        date: inv.paidAt || inv.createdAt,
        type: 'expense',
        category: 'gym_payout',
        description: `Gym payout — ${inv.gymName || inv.gymId}${inv.periodStart ? ` (${inv.periodStart} – ${inv.periodEnd})` : ''}`,
        amount: inv.amount || 0,
        reference: inv.paymentReference || null,
        gymId: inv.gymId
      });
    }

    entries.sort((a, b) => +new Date(b.date) - +new Date(a.date));
    res.json(entries);
  }
};

// ───────────────────────────────────────── Invoices ────────────────────────────────────────

const invoices = collection('invoices');

export const adminListInvoices = {
  created, method: 'get', path: '/admin/invoices',
  description: 'Admin: list all invoices with optional filters (?gymId=&status=&ownerId=).',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    let list = invoices.filter(() => true);
    if (req.query?.gymId) list = list.filter(i => i.gymId === req.query.gymId);
    if (req.query?.status) list = list.filter(i => i.status === req.query.status);
    if (req.query?.ownerId) list = list.filter(i => i.ownerId === req.query.ownerId);
    list.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    res.json(list);
  }
};

export const adminCreateInvoice = {
  created, method: 'post', path: '/admin/invoices',
  description: 'Admin: create an invoice for a gym unpaid balance.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const { gymId, amount, note, periodStart, periodEnd } = req.body || {};
    if (!gymId || !amount) return res.status(400).json({ error: 'gymId and amount required' });

    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return res.status(404).json({ error: 'gym_not_found' });

    // Find owner for this gym
    const owner = users.find(u => u.userType === 'gym_operator' && (u.gymId === gymId || (u.gymIds || []).includes(gymId)));

    const inv = {
      id: randomUUID(),
      gymId,
      gymName: gym.name,
      ownerId: owner?.id || null,
      ownerName: owner?.displayName || owner?.email || null,
      amount: Number(amount),
      status: 'unpaid',
      note: note || null,
      periodStart: periodStart || null,
      periodEnd: periodEnd || null,
      receiptUrl: null,
      paymentReference: null,
      createdAt: new Date().toISOString(),
      createdBy: req.user.sub,
      paidAt: null,
    };
    invoices.insert(inv);
    auditLog.insert({
      id: randomUUID(), at: inv.createdAt,
      actor: req.user.sub, action: 'invoice_created',
      target: inv.id, before: null, after: inv
    });
    res.json(inv);
  }
};

export const adminUpdateInvoice = {
  created, method: 'put', path: '/admin/invoices/:id',
  description: 'Admin: update invoice — upload receipt, mark as paid, edit note.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const inv = invoices.find(i => i.id === req.params.id);
    if (!inv) return res.status(404).json({ error: 'invoice_not_found' });

    const before = { ...inv };
    const { receiptUrl, paymentReference, status, note } = req.body || {};
    const updates = {};
    if (receiptUrl !== undefined) updates.receiptUrl = receiptUrl;
    if (paymentReference !== undefined) updates.paymentReference = paymentReference;
    if (note !== undefined) updates.note = note;
    if (status === 'paid') {
      updates.status = 'paid';
      updates.paidAt = new Date().toISOString();
      // Also record in gym_payouts for balance tracking
      const gymPayoutsCol = collection('gym_payouts');
      gymPayoutsCol.insert({
        id: randomUUID(),
        gymId: inv.gymId,
        invoiceId: inv.id,
        amount: inv.amount,
        status: 'paid',
        periodStart: inv.periodStart || null,
        periodEnd: inv.periodEnd || null,
        paidAt: updates.paidAt,
        reference: paymentReference || receiptUrl || null
      });
    } else if (status) {
      updates.status = status;
    }

    const updated = invoices.update(i => i.id === req.params.id, updates);
    auditLog.insert({
      id: randomUUID(), at: new Date().toISOString(),
      actor: req.user.sub, action: 'invoice_updated',
      target: inv.id, before, after: updated
    });
    res.json(updated);
  }
};

export const adminGetInvoice = {
  created, method: 'get', path: '/admin/invoices/:id',
  description: 'Admin: get a single invoice by ID.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const inv = invoices.find(i => i.id === req.params.id);
    if (!inv) return res.status(404).json({ error: 'invoice_not_found' });
    res.json(inv);
  }
};

// ───────────────────────────────────────── Platform Settings ───────────────────────────────

const platformSettings = collection('platform_settings');

// Seed default settings if none exist
function ensureDefaultSettings() {
  const existing = platformSettings.find(s => s.id === 'platform');
  if (existing) return existing;
  const defaults = {
    id: 'platform',
    subscriptionTiers: [
      { key: 'basic',     label: 'Basic',     monthlyPrice: 60000,  visits: 8,  gymAccess: 'standard' },
      { key: 'pro',       label: 'Pro',       monthlyPrice: 120000, visits: 12, gymAccess: 'midtier' },
      { key: 'premium',   label: 'Premium',   monthlyPrice: 200000, visits: 20, gymAccess: 'premium' },
      { key: 'executive', label: 'Executive', monthlyPrice: 350000, visits: -1, gymAccess: 'luxury_executive' },
    ],
    payoutBands: [
      { key: 'band1', label: 'Band 1', minVisits: 1,  maxVisits: 2,  payoutTiming: 'daily',     commissionPct: 15 },
      { key: 'band2', label: 'Band 2', minVisits: 3,  maxVisits: 7,  payoutTiming: 'weekly',    commissionPct: 10 },
      { key: 'band3', label: 'Band 3', minVisits: 8,  maxVisits: 14, payoutTiming: 'biweekly',  commissionPct: 10 },
      { key: 'band4', label: 'Band 4', minVisits: 15, maxVisits: -1, payoutTiming: 'monthly',   commissionPct: 8  },
    ],
    paymentPeriodDays: 14,
    payoutModel: 'commission',
    currency: 'TZS',
    updatedAt: new Date().toISOString(),
  };
  platformSettings.insert(defaults);
  return defaults;
}

export const publicSubscriptionTiers = {
  created, method: 'get', path: '/subscription-tiers',
  description: 'Public: subscription tier catalogue from platform settings, including gym tier access per plan.',
  onRequest: (_req, res) => {
    const settings = ensureDefaultSettings();
    const tiers = (settings.subscriptionTiers || []).map(t => ({
      key: t.key,
      label: t.label,
      monthlyPrice: t.monthlyPrice,
      visits: t.visits,
      gymAccess: t.gymAccess,
    }));
    res.json(tiers);
  }
};

export const adminGetSettings = {
  created, method: 'get', path: '/admin/settings',
  description: 'Admin: get platform settings (tiers, bands, payment period, etc.).',
  onGuard: requireAuth('admin'),
  onRequest: (_req, res) => {
    const settings = ensureDefaultSettings();
    res.json(settings);
  }
};

export const adminUpdateSettings = {
  created, method: 'put', path: '/admin/settings',
  description: 'Admin: update platform settings.',
  onGuard: requireAuth('admin'),
  onRequest: (req, res) => {
    const current = ensureDefaultSettings();
    const before = { ...current };
    const patch = req.body || {};
    const allowed = ['subscriptionTiers', 'payoutBands', 'paymentPeriodDays', 'payoutModel', 'currency'];
    const updates = {};
    for (const k of allowed) {
      if (patch[k] !== undefined) updates[k] = patch[k];
    }
    updates.updatedAt = new Date().toISOString();
    const updated = platformSettings.update(s => s.id === 'platform', updates);
    auditLog.insert({
      id: randomUUID(), at: updates.updatedAt,
      actor: req.user.sub, action: 'settings_updated',
      target: 'platform', before, after: updated
    });
    res.json(updated);
  }
};

// ───────────────────────────────────────── Renewal scheduler (stub) ───────────────────────
export const renewalNotifier = {
  created, rule: '0 9 * * *', // every day 09:00 UTC
  description: 'Send T-3 / T-1 / T0 renewal notifications (BL-008). Currently logs only — push/SMS pending US-020.',
  onJob: () => {
    const now = Date.now();
    subscriptions.filter(s => s.status === 'active').forEach(s => {
      const days = Math.round((+new Date(s.renewsAt) - now) / 86_400_000);
      if ([3, 1, 0].includes(days)) {
        console.log(`[renewal] member=${s.memberId} sub=${s.id} T-${days} renewsAt=${s.renewsAt}`);
      }
    });
  }
};

// ───────────────────────────────────────── Selcom webhook (stub, idempotent) ──────────────
export const selcomWebhook = {
  created, method: 'post', path: '/webhooks/selcom',
  description: 'Selcom payment webhook. Idempotent on payment_id. ⛔ OI-004: signature verification pending.',
  requestSample: { payment_id: 'sel_x', status: 'success', subscription_id: 'sub_x' },
  onRequest: (req, res) => {
    const { payment_id, status, subscription_id } = req.body || {};
    if (!payment_id) return res.status(400).json({ error: 'missing_payment_id' });
    const seen = collection('webhook_seen');
    if (seen.find(w => w.id === payment_id)) return res.json({ ok: true, idempotent: true });
    seen.insert({ id: payment_id, at: new Date().toISOString() });
    if (status === 'success' && subscription_id) {
      subscriptions.update(s => s.id === subscription_id, { status: 'active', paymentRef: payment_id });
    }
    res.json({ ok: true });
  }
};
