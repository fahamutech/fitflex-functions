// Terms and conditions a user agrees to when they set up an account or add a
// role — members get the FitFlex Terms, partners their partner agreement.
import '../src/bootstrap/init.mjs';
import { requireAuth } from '../src/auth/jwt.mjs';
import { termsService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

const send = (res, result) => {
  if (result.error) {
    const { error, status, ...extra } = result;
    return res.status(status).json({ error, ...extra });
  }
  res.json(result);
};

const acceptanceMeta = req => {
  const h = req.headers || {};
  const forwarded = typeof h['x-forwarded-for'] === 'string' ? h['x-forwarded-for'].split(',')[0].trim() : '';
  return { ip: forwarded || req.ip || req.socket?.remoteAddress || null, userAgent: h['user-agent'] || null };
};

export const myTerms = {
  created, method: 'get', path: '/me/terms',
  description: 'Any signed-in user: the terms for their role (member: FitFlex Terms; gym owner / trainer / vendor: partner agreement) with title, sections, version and whether the current version is accepted. ?lang=en|sw. ?role=trainer|gym_operator|vendor|member previews the text for a role the user is about to add.',
  responseSample: { role: 'trainer', required: true, accepted: false, acceptedAt: null, kind: 'partner_agreement', version: '2026-09-29', reference: 'FFA-TPT-001 (online) v1.0', title: 'FitFlex Trainer Partner Terms', sections: [{ heading: 'Parties', text: '…' }], lang: 'en' },
  onGuard: requireAuth(),
  onRequest: async (req, res) => send(res, await termsService.current({
    userId: req.user.sub, lang: req.query?.lang, role: req.query?.role || null,
  })),
};

export const acceptMyTerms = {
  created, method: 'post', path: '/me/terms',
  description: 'Any signed-in user: accept the current terms for their role. Body { version } must be the current version (409 terms_version_outdated with the current one otherwise). Accepting again changes nothing.',
  requestSample: { version: '2026-09-29' },
  onGuard: requireAuth(),
  onRequest: async (req, res) => send(res, await termsService.accept({
    userId: req.user.sub, version: req.body?.version, meta: acceptanceMeta(req),
  })),
};
