// Moderation & Promotion, phase 1 — the data model.
//
//   ModerationState      one row per entity that has been through moderation.
//                        No row = approved, so every existing listing is unchanged.
//   ModerationEvent      append-only history of moderation decisions
//   GeoArea              country > region > city > district, for targeting
//   PromotionCampaign    a named, time-boxed push (e.g. Zanzibar Fitness Week)
//   Promotion            the promotion record: what, where, when, how strongly, on what terms
//   PromotionPlacement   which placements a promotion occupies
//   PlacementConfig      per placement and type: slots, boost cap and rotation (settings, not code)
//
// Additive only. Gym and TrainerProfile gain regionId / cityId (nullable), filled
// where the free-text location names a known area. Nothing here changes what the
// public sees: discovery is untouched until a later phase.

const list = values => values.map(v => `'${v}'`).join(', ');
const MOD_STATUSES = ['pending', 'approved', 'rejected', 'suspended', 'hidden'];
const ENTITY_TYPES = ['gym', 'trainer', 'vendor', 'product'];
const PROMO_STATUSES = ['draft', 'pending_approval', 'approved', 'scheduled', 'active', 'paused', 'expired', 'completed', 'rejected', 'cancelled'];
const PROMO_TYPES = ['featured', 'promoted', 'sponsored', 'recommended', 'campaign'];
const CAMPAIGN_STATUSES = ['draft', 'active', 'ended', 'cancelled'];
const AREA_LEVELS = ['country', 'region', 'city', 'district'];
const PLACEMENTS = ['gym_discovery', 'trainer_discovery', 'vendor_discovery', 'marketplace', 'search_results', 'home', 'campaign_page'];

// [id, level, name, parentId, lat, lng, radiusKm] — a starting list; admins can add areas.
const AREAS = [
  ['tz', 'country', 'Tanzania', null, -6.369, 34.889, null],
  ['tz-dar', 'region', 'Dar es Salaam', 'tz', -6.792, 39.208, 40],
  ['tz-dar-city', 'city', 'Dar es Salaam', 'tz-dar', -6.792, 39.208, 25],
  ['tz-znz', 'region', 'Zanzibar', 'tz', -6.165, 39.202, 60],
  ['tz-znz-city', 'city', 'Zanzibar City', 'tz-znz', -6.165, 39.202, 12],
  ['tz-znz-stone-town', 'district', 'Stone Town', 'tz-znz-city', -6.163, 39.189, 3],
  ['tz-arusha', 'region', 'Arusha', 'tz', -3.387, 36.683, 60],
  ['tz-arusha-city', 'city', 'Arusha', 'tz-arusha', -3.387, 36.683, 15],
  ['tz-dodoma', 'region', 'Dodoma', 'tz', -6.163, 35.754, 80],
  ['tz-dodoma-city', 'city', 'Dodoma', 'tz-dodoma', -6.163, 35.754, 20],
  ['tz-mwanza', 'region', 'Mwanza', 'tz', -2.517, 32.9, 60],
  ['tz-mwanza-city', 'city', 'Mwanza', 'tz-mwanza', -2.517, 32.9, 15],
];

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  const ts = (t, col) => t.timestamp(col, { precision: 3 });

  if (!(await knex.schema.hasTable('GeoArea'))) {
    await knex.schema.createTable('GeoArea', (t) => {
      t.text('id').primary();
      t.text('level').notNullable();
      t.text('name').notNullable();
      t.text('parentId').references('id').inTable('GeoArea');
      t.double('lat');
      t.double('lng');
      t.double('radiusKm');
      t.boolean('active').notNullable().defaultTo(true);
      ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
      ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
      t.index(['parentId']);
    });
    await knex.raw(`ALTER TABLE "GeoArea" ADD CONSTRAINT geoarea_level_chk CHECK ("level" IN (${list(AREA_LEVELS)}))`);
    await knex('GeoArea').insert(AREAS.map(([id, level, name, parentId, lat, lng, radiusKm]) => ({ id, level, name, parentId, lat, lng, radiusKm })));
  }

  for (const table of ['Gym', 'TrainerProfile']) {
    for (const column of ['regionId', 'cityId']) {
      if (!(await knex.schema.hasColumn(table, column))) {
        await knex.schema.alterTable(table, (t) => { t.text(column).references('id').inTable('GeoArea').onDelete('SET NULL'); });
      }
    }
  }
  // Best-effort fill from the free-text address: the most specific name found wins. Never overwrites.
  await knex.raw(`
    UPDATE "Gym" g SET "regionId" = a."regionId", "cityId" = a."cityId" FROM (
      SELECT g2."id" AS gid,
             COALESCE(d."id", c."id", r."id") AS best,
             COALESCE(r."id", rc."id") AS "regionId",
             COALESCE(c."id", cd."id") AS "cityId"
      FROM "Gym" g2
      LEFT JOIN "GeoArea" d ON d."level" = 'district' AND g2."location" ILIKE '%' || d."name" || '%'
      LEFT JOIN "GeoArea" cd ON cd."id" = d."parentId"
      LEFT JOIN "GeoArea" c ON c."level" = 'city' AND g2."location" ILIKE '%' || c."name" || '%'
      LEFT JOIN "GeoArea" r ON r."level" = 'region' AND g2."location" ILIKE '%' || r."name" || '%'
      LEFT JOIN "GeoArea" rc ON rc."id" = COALESCE(c."parentId", cd."parentId")
      WHERE g2."regionId" IS NULL
    ) a WHERE g."id" = a.gid AND a."regionId" IS NOT NULL
  `);
  await knex.raw(`
    UPDATE "TrainerProfile" t SET "regionId" = x."regionId", "cityId" = x."cityId" FROM (
      SELECT DISTINCT ON (l."trainerId") l."trainerId" AS tid, g."regionId", g."cityId"
      FROM "TrainerProfileGym" l JOIN "Gym" g ON g."id" = l."gymId"
      WHERE g."regionId" IS NOT NULL ORDER BY l."trainerId", g."id"
    ) x WHERE t."id" = x.tid AND t."regionId" IS NULL
  `);

  if (!(await knex.schema.hasTable('ModerationState'))) {
    await knex.schema.createTable('ModerationState', (t) => {
      t.text('id').primary();                       // "<entityType>:<entityId>"
      t.text('entityType').notNullable();
      t.text('entityId').notNullable();
      t.text('status').notNullable();
      t.text('reason');
      t.text('decidedBy');
      ts(t, 'decidedAt');
      ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
      ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
      t.unique(['entityType', 'entityId']);
      t.index(['entityType', 'status']);
    });
    await knex.raw(`ALTER TABLE "ModerationState" ADD CONSTRAINT modstate_status_chk CHECK ("status" IN (${list(MOD_STATUSES)}))`);
    await knex.raw(`ALTER TABLE "ModerationState" ADD CONSTRAINT modstate_entity_chk CHECK ("entityType" IN (${list(ENTITY_TYPES)}))`);
  }

  if (!(await knex.schema.hasTable('ModerationEvent'))) {
    await knex.schema.createTable('ModerationEvent', (t) => {
      t.text('id').primary();
      t.text('entityType').notNullable();
      t.text('entityId').notNullable();
      t.text('action').notNullable();
      t.text('fromStatus');
      t.text('toStatus').notNullable();
      t.text('reason');
      t.text('actor').notNullable();
      ts(t, 'at').notNullable().defaultTo(knex.fn.now());
      t.index(['entityType', 'entityId', 'at']);
    });
  }

  if (!(await knex.schema.hasTable('PromotionCampaign'))) {
    await knex.schema.createTable('PromotionCampaign', (t) => {
      t.text('id').primary();
      t.text('name').notNullable();
      t.text('description');
      t.text('status').notNullable().defaultTo('draft');
      t.text('statusReason');
      ts(t, 'startsAt').notNullable();
      ts(t, 'endsAt').notNullable();
      t.jsonb('geoScope').notNullable().defaultTo('{"areaIds":[]}');
      t.text('createdBy').notNullable();
      ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
      ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
    });
    await knex.raw(`ALTER TABLE "PromotionCampaign" ADD CONSTRAINT promocampaign_status_chk CHECK ("status" IN (${list(CAMPAIGN_STATUSES)}))`);
    await knex.raw(`ALTER TABLE "PromotionCampaign" ADD CONSTRAINT promocampaign_period_chk CHECK ("endsAt" > "startsAt")`);
  }

  if (!(await knex.schema.hasTable('Promotion'))) {
    await knex.schema.createTable('Promotion', (t) => {
      t.text('id').primary();
      t.text('entityType').notNullable();
      t.text('entityId').notNullable();
      t.text('type').notNullable();
      t.text('status').notNullable().defaultTo('draft');
      t.text('statusReason');
      ts(t, 'statusChangedAt');
      t.text('campaignId').references('id').inTable('PromotionCampaign');
      t.text('partnerRef');                         // B2BOrganization id, where the partner is one
      ts(t, 'startsAt').notNullable();
      ts(t, 'endsAt').notNullable();
      t.integer('priority').notNullable().defaultTo(10);       // 1 = strongest
      t.double('boostWeight').notNullable().defaultTo(1);      // 0..1 of the placement's boost cap
      t.jsonb('geoScope').notNullable().defaultTo('{"areaIds":[]}');
      t.jsonb('audience').notNullable().defaultTo('{}');
      t.jsonb('categories').notNullable().defaultTo('[]');
      t.boolean('isCommercial').notNullable().defaultTo(false);
      t.text('relationshipType');
      t.text('commercialRef');
      t.text('disclosureLabel');
      t.text('notes');
      t.text('createdBy').notNullable();
      t.text('submittedBy');
      ts(t, 'submittedAt');
      t.text('approvedBy');
      ts(t, 'approvedAt');
      ts(t, 'activatedAt');
      ts(t, 'pausedAt');
      ts(t, 'createdAt').notNullable().defaultTo(knex.fn.now());
      ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
      t.index(['status', 'startsAt', 'endsAt']);
      t.index(['entityType', 'entityId']);
      t.index(['campaignId']);
    });
    await knex.raw(`ALTER TABLE "Promotion" ADD CONSTRAINT promotion_status_chk CHECK ("status" IN (${list(PROMO_STATUSES)}))`);
    await knex.raw(`ALTER TABLE "Promotion" ADD CONSTRAINT promotion_type_chk CHECK ("type" IN (${list(PROMO_TYPES)}))`);
    await knex.raw(`ALTER TABLE "Promotion" ADD CONSTRAINT promotion_entity_chk CHECK ("entityType" IN (${list(ENTITY_TYPES)}))`);
    await knex.raw(`ALTER TABLE "Promotion" ADD CONSTRAINT promotion_period_chk CHECK ("endsAt" > "startsAt")`);
    await knex.raw(`ALTER TABLE "Promotion" ADD CONSTRAINT promotion_priority_chk CHECK ("priority" BETWEEN 1 AND 100)`);
    await knex.raw(`ALTER TABLE "Promotion" ADD CONSTRAINT promotion_boost_chk CHECK ("boostWeight" BETWEEN 0 AND 1)`);
    // Sponsored is paid; Recommended is not — enforced here as well as in the service.
    await knex.raw(`ALTER TABLE "Promotion" ADD CONSTRAINT promotion_commercial_chk CHECK (("type" <> 'sponsored' OR "isCommercial") AND ("type" <> 'recommended' OR NOT "isCommercial"))`);
  }

  if (!(await knex.schema.hasTable('PromotionPlacement'))) {
    await knex.schema.createTable('PromotionPlacement', (t) => {
      t.text('id').primary();                       // "<promotionId>:<placement>"
      t.text('promotionId').notNullable().references('id').inTable('Promotion').onDelete('CASCADE');
      t.text('placement').notNullable();
      t.unique(['promotionId', 'placement']);
      t.index(['placement']);
    });
    await knex.raw(`ALTER TABLE "PromotionPlacement" ADD CONSTRAINT promoplacement_chk CHECK ("placement" IN (${list(PLACEMENTS)}))`);
  }

  if (!(await knex.schema.hasTable('PlacementConfig'))) {
    await knex.schema.createTable('PlacementConfig', (t) => {
      t.text('id').primary();                       // "<placement>:<promotionType>"
      t.text('placement').notNullable();
      t.text('promotionType').notNullable();
      t.integer('maxSlots').notNullable();
      t.double('maxBoostFraction');                 // null = platform default
      t.text('rotationMode').notNullable().defaultTo('time_slice');
      t.integer('rotationWindowMinutes').notNullable().defaultTo(60);
      t.text('updatedBy');
      ts(t, 'updatedAt').notNullable().defaultTo(knex.fn.now());
      t.unique(['placement', 'promotionType']);
    });
    await knex.raw(`ALTER TABLE "PlacementConfig" ADD CONSTRAINT placementcfg_placement_chk CHECK ("placement" IN (${list(PLACEMENTS)}))`);
    await knex.raw(`ALTER TABLE "PlacementConfig" ADD CONSTRAINT placementcfg_type_chk CHECK ("promotionType" IN (${list(PROMO_TYPES)}))`);
    await knex.raw(`ALTER TABLE "PlacementConfig" ADD CONSTRAINT placementcfg_slots_chk CHECK ("maxSlots" >= 0)`);
    await knex.raw(`ALTER TABLE "PlacementConfig" ADD CONSTRAINT placementcfg_boost_chk CHECK ("maxBoostFraction" IS NULL OR ("maxBoostFraction" >= 0 AND "maxBoostFraction" <= 1))`);
    await knex.raw(`ALTER TABLE "PlacementConfig" ADD CONSTRAINT placementcfg_rotation_chk CHECK ("rotationMode" IN ('none', 'time_slice') AND "rotationWindowMinutes" >= 1)`);
  }
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  for (const table of ['PlacementConfig', 'PromotionPlacement', 'Promotion', 'PromotionCampaign', 'ModerationEvent', 'ModerationState']) {
    await knex.schema.dropTableIfExists(table);
  }
  for (const table of ['Gym', 'TrainerProfile']) {
    for (const column of ['regionId', 'cityId']) {
      if (await knex.schema.hasColumn(table, column)) await knex.schema.alterTable(table, (t) => { t.dropColumn(column); });
    }
  }
  await knex.schema.dropTableIfExists('GeoArea');
};
