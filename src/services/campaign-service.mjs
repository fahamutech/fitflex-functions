// Communication campaigns — a gym (to its direct members) or FitFlex (to
// any member) writes a message, picks an audience and channels, previews
// it, then sends it now or schedules it.
//
// Sending turns the audience into rows in the CommunicationMessage ledger:
// one per member per chosen channel, `queued` where the member can be
// reached and `skipped` (with the reason) where they can't. The dispatcher
// (M5) delivers queued rows. Safety:
// - a Send carries a client-generated sendRequestId; repeating it returns
//   the same result, and the unique ledger keys stop any double message;
// - the move out of draft/scheduled is a conditional update, so two
//   devices pressing Send at once can't both queue;
// - large audiences need an explicit confirmation;
// - a member gets at most MARKETING_WEEKLY_CAP marketing campaigns a week,
//   counted across every gym and FitFlex.
import { randomUUID } from 'node:crypto';
import {
  CHANNELS, PURPOSES, CAMPAIGN_STATUSES, categoryForPurpose, canTransitionCampaign,
  validateContent, messageValues, renderText, contentFor,
} from '../shared/communications.mjs';
import { buildAudienceFilter, audienceScope } from '../shared/audience.mjs';
import { ownerGymIds } from '../shared/member-status.mjs';

const EDITABLE = ['draft'];
const SENDABLE = ['draft', 'scheduled'];
const MIN_SCHEDULE_LEAD_MS = 5 * 60_000;
const MAX_SCHEDULE_AHEAD_MS = 90 * 86_400_000;
const NAME_MAX = 80;
const LIST_LIMIT = 50;
const INSERT_CHUNK = 500;

const id = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const hasTranslations = (content) => Boolean(content?.translations && Object.keys(content.translations).length);
const iso = (v) => (v == null ? null : new Date(v).toISOString());

export function createCampaignService({
  db, campaigns, gyms, segmentService, auditLog,
  templateService = null,
  // Delivery numbers from the ledger (communication-history-service).
  historyService = null,
  now = () => new Date(),
  largeSendThreshold = 200,
  marketingWeeklyCap = 2,
  renewalLink = null,
}) {
  // ── who may see / act on what ────────────────────────────────────────────

  function scopeOf(sender) {
    return sender?.senderType === 'gym' ? 'gym' : sender?.senderType === 'platform' ? 'platform' : null;
  }

  function mayAccess(sender, campaign) {
    if (!campaign) return false;
    if (sender.senderType === 'platform') return campaign.senderType === 'platform';
    return campaign.senderType === 'gym' && ownerGymIds(sender.owner).includes(campaign.gymId);
  }

  async function load(sender, campaignId) {
    const c = await campaigns.findByIdAsync(campaignId);
    // Another gym's campaign looks exactly like one that doesn't exist.
    return mayAccess(sender, c) ? c : null;
  }

  function gymFor(sender, requested) {
    if (sender.senderType === 'platform') return { gymId: null };
    const mine = ownerGymIds(sender.owner);
    if (!mine.length) return { error: 'owner_has_no_gyms', status: 400 };
    if (requested != null) return mine.includes(requested) ? { gymId: requested } : { error: 'not_your_gym', status: 403 };
    return mine.length === 1 ? { gymId: mine[0] } : { error: 'gym_required', status: 400 };
  }

  // ── input ────────────────────────────────────────────────────────────────

  /**
   * Validates whichever draft fields are present; returns a patch.
   * `sender` lets a template be checked against what the sender may use.
   */
  async function draftFields(body, scope, sender = null) {
    const patch = {};
    if (body.templateId !== undefined) {
      if (body.templateId === null) patch.templateId = null;
      else {
        const tpl = templateService && sender ? await templateService.load(sender, body.templateId) : null;
        if (!tpl || tpl.status !== 'active') return { error: 'template_not_found', status: 404 };
        patch.templateId = tpl.id;
        // No text given: start from the template, in the sender's language.
        if (body.content === undefined) {
          const t = await templateService.contentFromTemplate(sender, tpl.id, { locale: body.locale || 'en', values: body.templateValues || {} });
          body = { ...body, content: t.content };
        }
        // The template's purpose, unless the sender chose one.
        if (body.purpose === undefined) body = { ...body, purpose: tpl.purpose };
      }
    }
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > NAME_MAX) return { error: 'invalid_name', status: 400 };
      patch.name = name;
    }
    if (body.purpose !== undefined) {
      if (!PURPOSES.includes(body.purpose)) return { error: 'invalid_purpose', status: 400 };
      patch.purpose = body.purpose;
      patch.category = categoryForPurpose(body.purpose);
    }
    if (body.audience !== undefined) {
      const { preset = null, filter = null, recipients = 'members' } = body.audience || {};
      // FitFlex may address trainers instead of members; gyms only members.
      const audScope = audienceScope(scope, recipients);
      if (!audScope) return { error: 'invalid_recipients', status: 400 };
      const built = buildAudienceFilter({ preset: preset ?? undefined, filter: filter ?? undefined }, audScope);
      if (built.error) return built;
      patch.audience = { preset, filter, ...(recipients === 'members' ? {} : { recipients }) };
    }
    if (body.content !== undefined) {
      const v = validateContent(body.content, { renewalLinkAvailable: Boolean(renewalLink) });
      if (v.error) return v;
      patch.content = v.content;
    }
    if (body.channels !== undefined) {
      const chosen = Array.isArray(body.channels) ? [...new Set(body.channels)] : null;
      if (!chosen?.length || !chosen.every(ch => CHANNELS.includes(ch))) return { error: 'invalid_channels', status: 400 };
      const available = segmentService.channelAvailability();
      const off = chosen.find(ch => !available[ch]);
      if (off) return { error: 'channel_unavailable', status: 400, detail: off };
      patch.channels = chosen;
    }
    return { patch };
  }

  /**
   * WhatsApp only carries provider-approved templates: a campaign can use
   * it only when its template maps to an approved WhatsApp template.
   */
  async function whatsappCheck(sender, campaign) {
    if (!campaign.channels?.includes('whatsapp')) return null;
    const tpl = campaign.templateId && templateService ? await templateService.load(sender, campaign.templateId) : null;
    const status = tpl ? await templateService.whatsappStatus(tpl) : null;
    return status?.ready ? null : { error: 'whatsapp_template_required', status: 400 };
  }

  function readyToSend(c) {
    if (!c.purpose) return 'purpose_required';
    if (!c.audience) return 'audience_required';
    if (!c.content) return 'content_required';
    if (!c.channels?.length) return 'channels_required';
    return null;
  }

  function view(c) {
    return {
      id: c.id, senderType: c.senderType, gymId: c.gymId, name: c.name, purpose: c.purpose,
      category: c.category, status: c.status, audience: c.audience, content: c.content,
      channels: c.channels || [], templateId: c.templateId || null, scheduledAt: iso(c.scheduledAt), sentAt: iso(c.sentAt),
      cancelledAt: iso(c.cancelledAt), counts: c.counts || null, createdBy: c.createdBy,
      createdAt: iso(c.createdAt), updatedAt: iso(c.updatedAt),
    };
  }

  function audienceSender(sender, campaign) {
    return campaign.senderType === 'gym'
      ? { senderType: 'gym', owner: sender.owner, gymId: campaign.gymId }
      : { senderType: 'platform' };
  }

  async function gymName(campaign) {
    if (!campaign.gymId) return 'FitFlex';
    return (await gyms.findByIdAsync(campaign.gymId))?.name || '';
  }

  /** One member's copy, in their app language when the message has it. */
  function render(content, member, name, locale = null) {
    const text = contentFor(content, locale);
    const values = messageValues(content, member, { gymName: name, renewalLink: renewalLink || '', locale: text.locale });
    return {
      title: renderText(text.title, values),
      body: renderText(text.body, values),
      ctaLabel: text.ctaLabel,
      deepLink: content.deepLink || 'message',
      locale: text.locale,
      values,
    };
  }

  /**
   * A campaign's approved WhatsApp templates by language (empty without
   * WhatsApp). Worked out once per send.
   */
  async function whatsappMappingFor(sender, campaign) {
    if (!campaign.channels?.includes('whatsapp') || !campaign.templateId || !templateService) return new Map();
    const tpl = await templateService.load(sender, campaign.templateId);
    return tpl ? templateService.whatsappMapping(tpl) : new Map();
  }

  /**
   * A member's WhatsApp copy. WhatsApp only carries the provider-approved
   * wording, so this is the template's own text — in the member's language
   * when that version is approved, otherwise in one that is — not the
   * sender's edits. Its parameters are the member's values in the order the
   * provider template numbers them ({{1}}, {{2}}, …).
   */
  function whatsappCopy(content, member, name, locale, mapping) {
    const wa = mapping.get(locale) || [...mapping.values()][0];
    if (!wa) return null;
    const text = { ...content, title: wa.text.title, body: wa.text.body, ctaLabel: wa.text.ctaLabel, locale: wa.language, translations: undefined };
    const copy = render(text, member, name, wa.language);
    return {
      copy,
      payload: { templateName: wa.templateName, language: wa.language, parameters: wa.variables.map(v => String(copy.values[v] ?? '')) },
    };
  }

  // Members who already got the weekly maximum of marketing campaigns.
  async function atMarketingCap(memberIds) {
    if (!memberIds.length || marketingWeeklyCap <= 0) return new Set(memberIds);
    const since = new Date(+now() - 7 * 86_400_000);
    const capped = new Set();
    for (let i = 0; i < memberIds.length; i += 1000) {
      const rows = await db('CommunicationMessage')
        .whereIn('memberId', memberIds.slice(i, i + 1000))
        .where('category', 'marketing')
        .whereNot('status', 'skipped')
        .where('createdAt', '>=', since)
        .groupBy('memberId')
        .select('memberId')
        .countDistinct({ n: db.raw('coalesce("campaignId", "automationRunId")') });
      for (const r of rows) if (Number(r.n) >= marketingWeeklyCap) capped.add(r.memberId);
    }
    return capped;
  }

  /**
   * Who a campaign would reach and how, without saving anything:
   * { members, rows, counts }. Shared by preview and send.
   */
  async function plan(sender, campaign) {
    const r = await segmentService.resolveAudience({
      sender: audienceSender(sender, campaign),
      recipients: campaign.audience.recipients || 'members',
      preset: campaign.audience.preset ?? undefined,
      filter: campaign.audience.filter ?? undefined,
    });
    if (r.error) return r;
    const members = r.members;
    const reach = await segmentService.reachByMember(members, campaign.category, campaign.channels);
    const capped = campaign.category === 'marketing' ? await atMarketingCap(members.map(m => m.memberId)) : new Set();
    const name = await gymName(campaign);
    const mapping = await whatsappMappingFor(sender, campaign);
    const locales = hasTranslations(campaign.content) || mapping.size
      ? await segmentService.localesByMember(members.map(m => m.memberId))
      : new Map();
    const at = now().toISOString();
    const counts = { targeted: members.length, queued: 0, skipped: {}, byChannel: {} };
    const rows = [];
    for (const m of members) {
      const msg = render(campaign.content, m, name, locales.get(m.memberId));
      for (const ch of campaign.channels) {
        let copy = msg;
        let payload = null;
        let reason = capped.has(m.memberId) ? 'marketing_cap' : reach.get(m.memberId)?.[ch] ?? null;
        if (ch === 'whatsapp' && !reason) {
          const wa = whatsappCopy(campaign.content, m, name, locales.get(m.memberId) || msg.locale, mapping);
          if (!wa) reason = 'whatsapp_template_not_approved';
          else ({ copy, payload } = wa);
        }
        const byCh = counts.byChannel[ch] || (counts.byChannel[ch] = { queued: 0, skipped: 0 });
        if (reason) { counts.skipped[reason] = (counts.skipped[reason] || 0) + 1; byCh.skipped += 1; }
        else { counts.queued += 1; byCh.queued += 1; }
        rows.push({
          id: id('cmm'), campaignId: campaign.id, senderType: campaign.senderType, gymId: campaign.gymId,
          memberId: m.memberId, channel: ch, category: campaign.category, messageType: campaign.purpose,
          title: copy.title, body: copy.body, deepLink: copy.deepLink, locale: copy.locale,
          ...(payload ? { payload } : {}),
          status: reason ? 'skipped' : 'queued', skipReason: reason, attempts: 0,
          nextAttemptAt: reason ? null : at, createdAt: at, updatedAt: at,
        });
      }
    }
    return { members, rows, counts };
  }

  // ── use cases ────────────────────────────────────────────────────────────

  async function create(sender, body = {}) {
    const scope = scopeOf(sender);
    if (!scope) return { error: 'invalid_sender', status: 400 };
    const gym = gymFor(sender, body.gymId ?? null);
    if (gym.error) return gym;
    if (body.purpose === undefined && body.templateId == null) return { error: 'invalid_purpose', status: 400 };
    const f = await draftFields(body, scope, sender);
    if (f.error) return f;
    const at = now().toISOString();
    const row = {
      id: id('cmp'), senderType: scope, gymId: gym.gymId,
      name: f.patch.name || f.patch.content?.title || 'Untitled message',
      status: 'draft', channels: [], createdBy: sender.actorId || null, createdAt: at, updatedAt: at,
      ...f.patch,
    };
    row.name = row.name.slice(0, NAME_MAX);
    await campaigns.insertAsync(row);
    return { campaign: view(await campaigns.findByIdAsync(row.id)) };
  }

  async function update(sender, campaignId, body = {}) {
    const c = await load(sender, campaignId);
    if (!c) return { error: 'not_found', status: 404 };
    if (!EDITABLE.includes(c.status)) return { error: 'not_editable', status: 409 };
    const f = await draftFields(body, c.senderType, sender);
    if (f.error) return f;
    if (!Object.keys(f.patch).length) return { campaign: view(c) };
    return { campaign: view(await campaigns.updateByIdAsync(c.id, f.patch)) };
  }

  async function remove(sender, campaignId) {
    const c = await load(sender, campaignId);
    if (!c) return { error: 'not_found', status: 404 };
    if (c.status !== 'draft') return { error: 'only_drafts_can_be_deleted', status: 409 };
    await db('CommunicationCampaign').where({ id: c.id, status: 'draft' }).del();
    return { ok: true };
  }

  async function transition(sender, campaignId, to, patch = {}) {
    const c = await load(sender, campaignId);
    if (!c) return { error: 'not_found', status: 404 };
    if (!canTransitionCampaign(c.status, to)) return { error: 'invalid_state', status: 409, detail: c.status };
    const n = await db('CommunicationCampaign').where({ id: c.id, status: c.status })
      .update({ status: to, ...patch, updatedAt: now() });
    if (!n) return { error: 'invalid_state', status: 409 };
    return { campaign: view(await campaigns.findByIdAsync(c.id)), before: c };
  }

  async function schedule(sender, campaignId, { scheduledAt, confirmLargeSend = false } = {}) {
    const c = await load(sender, campaignId);
    if (!c) return { error: 'not_found', status: 404 };
    const missing = readyToSend(c);
    if (missing) return { error: 'incomplete', status: 400, detail: missing };
    const when = Date.parse(scheduledAt);
    if (Number.isNaN(when)) return { error: 'invalid_schedule', status: 400 };
    if (when < +now() + MIN_SCHEDULE_LEAD_MS) return { error: 'schedule_too_soon', status: 400 };
    if (when > +now() + MAX_SCHEDULE_AHEAD_MS) return { error: 'schedule_too_far', status: 400 };
    const wa = await whatsappCheck(sender, c);
    if (wa) return wa;
    // The same checks as sending now, so scheduling is no way around them.
    // The audience is worked out again when the campaign goes out.
    const p = await plan(sender, c);
    if (p.error) return p;
    if (!p.counts.targeted) return { error: 'empty_audience', status: 409 };
    if (p.counts.targeted >= largeSendThreshold && confirmLargeSend !== true) {
      return { error: 'confirm_large_send', status: 409, count: p.counts.targeted };
    }
    const r = await transition(sender, campaignId, 'scheduled', { scheduledAt: new Date(when) });
    if (r.error) return r;
    audit(sender, 'communication_campaign_scheduled', r.campaign, { scheduledAt: r.campaign.scheduledAt });
    return { campaign: r.campaign };
  }

  async function unschedule(sender, campaignId) {
    const r = await transition(sender, campaignId, 'draft', { scheduledAt: null });
    return r.error ? r : { campaign: r.campaign };
  }

  async function cancel(sender, campaignId) {
    const r = await transition(sender, campaignId, 'cancelled', { cancelledAt: now() });
    if (r.error) return r;
    audit(sender, 'communication_campaign_cancelled', r.campaign, { from: r.before.status });
    return { campaign: r.campaign };
  }

  /** Preview a campaign — saved (by id) or not yet saved (from a body). */
  async function preview(sender, { campaignId = null, body = null } = {}) {
    const scope = scopeOf(sender);
    if (!scope) return { error: 'invalid_sender', status: 400 };
    let c;
    if (campaignId) {
      c = await load(sender, campaignId);
      if (!c) return { error: 'not_found', status: 404 };
    } else {
      const gym = gymFor(sender, body?.gymId ?? null);
      if (gym.error) return gym;
      if (body?.purpose === undefined && body?.templateId == null) return { error: 'invalid_purpose', status: 400 };
      const f = await draftFields(body || {}, scope, sender);
      if (f.error) return f;
      c = { id: 'preview', senderType: scope, gymId: gym.gymId, channels: [], ...f.patch };
    }
    const missing = readyToSend(c);
    if (missing) return { error: 'incomplete', status: 400, detail: missing };
    const p = await plan(sender, c);
    if (p.error) return p;
    const sample = [...p.members].sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || '')));
    const name = await gymName(c);
    const warnings = [];
    if (p.counts.targeted >= largeSendThreshold) warnings.push({ code: 'large_send', count: p.counts.targeted });
    if (p.counts.skipped.marketing_cap) warnings.push({ code: 'marketing_cap', count: p.counts.skipped.marketing_cap });
    for (const ch of c.channels) if (!p.counts.byChannel[ch]?.queued) warnings.push({ code: 'channel_reaches_no_one', channel: ch });
    if (p.counts.targeted && !p.counts.queued) warnings.push({ code: 'nobody_reachable' });
    return {
      category: c.category,
      counts: p.counts,
      example: sample.length ? { memberName: sample[0].displayName, ...render(c.content, sample[0], name) } : null,
      warnings,
      largeSendThreshold,
    };
  }

  async function send(sender, campaignId, { sendRequestId, confirmLargeSend = false } = {}) {
    if (typeof sendRequestId !== 'string' || sendRequestId.length < 8 || sendRequestId.length > 100) {
      return { error: 'send_request_id_required', status: 400 };
    }
    const c = await load(sender, campaignId);
    if (!c) return { error: 'not_found', status: 404 };
    if (c.sendRequestId === sendRequestId) return { campaign: view(c), replayed: true };
    if (!SENDABLE.includes(c.status)) return { error: 'invalid_state', status: 409, detail: c.status };
    const missing = readyToSend(c);
    if (missing) return { error: 'incomplete', status: 400, detail: missing };
    // Channels may have been switched off on the server since the draft was saved.
    const available = segmentService.channelAvailability();
    const off = c.channels.find(ch => !available[ch]);
    if (off) return { error: 'channel_unavailable', status: 400, detail: off };
    const wa = await whatsappCheck(sender, c);
    if (wa) return wa;

    const p = await plan(sender, c);
    if (p.error) return p;
    if (!p.counts.targeted) return { error: 'empty_audience', status: 409 };
    if (p.counts.targeted >= largeSendThreshold && confirmLargeSend !== true) {
      return { error: 'confirm_large_send', status: 409, count: p.counts.targeted };
    }
    if (!p.counts.queued) return { error: 'nobody_reachable', status: 409, skipped: p.counts.skipped };

    const at = now();
    try {
      await db.transaction(async (trx) => {
        const n = await trx('CommunicationCampaign')
          .where({ id: c.id }).whereIn('status', SENDABLE)
          .update({ status: 'sending', sendRequestId, counts: JSON.stringify(p.counts), updatedAt: at });
        if (!n) throw Object.assign(new Error('state_changed'), { code: 'STATE_CHANGED' });
        await insertRows(trx, p.rows);
      });
    } catch (err) {
      const latest = await campaigns.findByIdAsync(c.id);
      if (latest?.sendRequestId === sendRequestId) return { campaign: view(latest), replayed: true };
      if (err.code === '23505') return { error: 'duplicate_send_request', status: 409 };
      if (err.code === 'STATE_CHANGED') return { error: 'invalid_state', status: 409, detail: latest?.status };
      throw err;
    }
    const sent = await campaigns.findByIdAsync(c.id);
    audit(sender, 'communication_campaign_sent', sent, { targeted: p.counts.targeted, queued: p.counts.queued });
    return { campaign: view(sent) };
  }

  async function insertRows(trx, rows) {
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await trx('CommunicationMessage').insert(rows.slice(i, i + INSERT_CHUNK))
        .onConflict(['campaignId', 'memberId', 'channel']).ignore();
    }
  }

  // Scheduled campaigns go out as the gym (its direct members) or FitFlex,
  // whoever created them — not as the person who pressed Schedule.
  function systemSender(campaign) {
    return campaign.senderType === 'gym'
      ? { senderType: 'gym', owner: { gymIds: [campaign.gymId] }, actorId: null }
      : { senderType: 'platform', actorId: null };
  }

  /**
   * Sends scheduled campaigns whose time has come: works out the audience
   * as it is now and queues each member's message, in one transaction with
   * the move out of `scheduled` — so a campaign cancelled at the last moment,
   * or released twice, is never queued twice.
   */
  async function releaseDue({ limit = 20 } = {}) {
    const due = await db('CommunicationCampaign')
      .where('status', 'scheduled').where('scheduledAt', '<=', now())
      .orderBy('scheduledAt').limit(limit).select('*');
    const stats = { released: 0, failed: 0, skipped: 0 };
    for (const c of due) {
      const sender = systemSender(c);
      const available = segmentService.channelAvailability();
      const blocked = !c.channels?.every(ch => available[ch]) ? { error: 'channel_unavailable' } : await whatsappCheck(sender, c);
      const p = blocked || await plan(sender, c);
      const at = now();
      if (p.error || !p.counts.queued) {
        const n = await db('CommunicationCampaign').where({ id: c.id, status: 'scheduled' }).update({
          status: 'failed', updatedAt: at, sentAt: at,
          counts: JSON.stringify(p.counts || { targeted: 0, queued: 0, skipped: {}, byChannel: {}, failure: p.error }),
        });
        stats[n ? 'failed' : 'skipped'] += 1;
        continue;
      }
      let claimed = 0;
      await db.transaction(async (trx) => {
        claimed = await trx('CommunicationCampaign').where({ id: c.id, status: 'scheduled' })
          .update({ status: 'sending', counts: JSON.stringify(p.counts), updatedAt: at });
        if (claimed) await insertRows(trx, p.rows);
      });
      if (!claimed) { stats.skipped += 1; continue; }
      stats.released += 1;
      audit(sender, 'communication_campaign_released', c, { targeted: p.counts.targeted, queued: p.counts.queued });
    }
    return stats;
  }

  /**
   * Campaign history, newest first. Filters: gymId, status, purpose,
   * channel, from/to (created), search (name or title); paged with an
   * opaque cursor. Each campaign carries who created it and its live
   * delivery numbers from the ledger.
   */
  async function list(sender, { gymId = null, status = null, purpose = null, channel = null, from = null, to = null, search = null, cursor = null, limit = LIST_LIMIT } = {}) {
    const size = Math.min(Math.max(Number(limit) || LIST_LIMIT, 1), 100);
    const q = db('CommunicationCampaign as c').leftJoin('User as u', 'u.id', 'c.createdBy');
    if (sender.senderType === 'platform') q.where('c.senderType', 'platform');
    else {
      const mine = ownerGymIds(sender.owner);
      if (gymId != null && !mine.includes(gymId)) return { error: 'not_your_gym', status: 403 };
      q.where('c.senderType', 'gym').whereIn('c.gymId', gymId != null ? [gymId] : mine);
    }
    const bad = (detail) => ({ error: 'invalid_filter', status: 400, detail });
    if (status) {
      const list = String(status).split(',');
      if (!list.every(x => CAMPAIGN_STATUSES.includes(x))) return bad('status');
      q.whereIn('c.status', list);
    }
    if (purpose) {
      if (!PURPOSES.includes(purpose)) return bad('purpose');
      q.where('c.purpose', purpose);
    }
    if (channel) {
      if (!CHANNELS.includes(channel)) return bad('channel');
      q.whereRaw('? = ANY(c.channels)', [channel]);
    }
    for (const [key, value, op] of [['from', from, '>='], ['to', to, '<=']]) {
      if (!value) continue;
      let d = new Date(value);
      if (Number.isNaN(+d)) return bad(key);
      if (key === 'to' && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) d = new Date(+d + 86_400_000 - 1);
      q.where('c.createdAt', op, d);
    }
    if (search && String(search).trim()) {
      const term = `%${String(search).trim().slice(0, 60).replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
      q.where(b => b.whereILike('c.name', term).orWhereRaw(`c.content->>'title' ILIKE ?`, [term]));
    }
    if (cursor) {
      let c;
      try { c = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { return bad('cursor'); }
      q.whereRaw(`(date_trunc('milliseconds', c."createdAt"), c.id) < (?::timestamptz, ?)`, [c?.a, c?.i]);
    }
    const rows = await q.orderBy([{ column: db.raw(`date_trunc('milliseconds', c."createdAt")`), order: 'desc' }, { column: 'c.id', order: 'desc' }])
      .limit(size + 1).select('c.*', 'u.displayName as createdByName');
    const page = rows.slice(0, size);
    const stats = historyService ? await historyService.campaignStats(page.map(r => r.id)) : new Map();
    const last = page.at(-1);
    return {
      campaigns: page.map(r => {
        const { content, audience, ...rest } = view(r);
        return { ...rest, title: content?.title ?? null, preset: audience?.preset ?? null, recipients: audience?.recipients || 'members', createdByName: r.createdByName ?? null, stats: stats.get(r.id) ?? null };
      }),
      nextCursor: rows.length > size ? Buffer.from(JSON.stringify({ a: new Date(last.createdAt).toISOString(), i: last.id })).toString('base64url') : null,
    };
  }

  /**
   * A campaign with live delivery progress per channel from the ledger,
   * its numbers, who created it and the template it started from.
   */
  async function get(sender, campaignId) {
    const c = await load(sender, campaignId);
    if (!c) return { error: 'not_found', status: 404 };
    const [rows, creator, template] = await Promise.all([
      db('CommunicationMessage').where('campaignId', c.id)
        .groupBy('channel', 'status').select('channel', 'status').count({ n: '*' }),
      c.createdBy ? db('User').where({ id: c.createdBy }).first('displayName') : null,
      c.templateId ? db('CommunicationTemplate').where({ id: c.templateId }).first('id', 'key', 'name', 'gymId') : null,
    ]);
    const progress = {};
    for (const r of rows) (progress[r.channel] ||= {})[r.status] = Number(r.n);
    const stats = historyService ? (await historyService.campaignStats([c.id])).get(c.id) : null;
    return {
      campaign: {
        ...view(c),
        createdByName: creator?.displayName ?? null,
        template: template ? { id: template.id, key: template.key, name: template.name, system: template.gymId == null } : null,
      },
      progress,
      stats,
    };
  }

  async function overview(sender, { gymId = null } = {}) {
    let gymIds = null;
    if (sender.senderType === 'gym') {
      const mine = ownerGymIds(sender.owner);
      if (!mine.length) return { error: 'owner_has_no_gyms', status: 400 };
      if (gymId != null && !mine.includes(gymId)) return { error: 'not_your_gym', status: 403 };
      gymIds = gymId != null ? [gymId] : mine;
    }
    const q = db('CommunicationCampaign').where('senderType', sender.senderType === 'gym' ? 'gym' : 'platform');
    if (gymIds) q.whereIn('gymId', gymIds);
    const byStatus = Object.fromEntries((await q.clone().groupBy('status').select('status').count({ n: '*' })).map(r => [r.status, Number(r.n)]));
    const recent = await list(sender, { gymId, limit: 5 });
    const audience = await segmentService.previewAudience({
      sender: sender.senderType === 'gym' ? { senderType: 'gym', owner: sender.owner, gymId } : { senderType: 'platform' },
      preset: 'all',
    });
    const trainerAudience = sender.senderType === 'platform'
      ? await segmentService.previewAudience({ sender: { senderType: 'platform' }, recipients: 'trainers', preset: 'all' })
      : null;
    return {
      senderType: sender.senderType,
      gymIds,
      members: audience.error ? null : audience.count,
      ...(trainerAudience ? { trainers: trainerAudience.error ? null : trainerAudience.count } : {}),
      campaigns: byStatus,
      recent: recent.campaigns || [],
      channels: segmentService.channelAvailability(),
      limits: { largeSendThreshold, marketingWeeklyCap },
    };
  }

  function audit(sender, action, campaign, after) {
    auditLog?.insertAsync?.({
      id: randomUUID(), at: now().toISOString(), actor: sender.actorId || null, action,
      target: campaign.id, before: null, after: { gymId: campaign.gymId, ...after },
    }).catch?.(() => {});
  }

  return { create, update, remove, schedule, unschedule, cancel, preview, send, list, get, overview, plan, releaseDue };
}
