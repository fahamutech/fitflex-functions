// Marathon & running events · S5 (2 of 2) — the organizer API credentials and signed webhooks.
// Design: docs/design/events-s5-venue-api-and-webhooks.md §5 (API clients), §7 (webhooks), §11.2; D38, D39.
//
// - ApiClient (S1): adds a name, the environment (live | sandbox), the events it is limited to, who made it, the
//   secret VERSION (an access token carries it, so a rotation ends tokens minted from a dead secret), the previous
//   secret's hash with its grace deadline, a per-client rate limit, and the token-endpoint lockout state. Only
//   hashes are stored; the secret is shown once at creation or rotation and never again.
// - EventOrganizer.apiAccessEnabledAt (D39): the pilot allowlist. NULL = not enabled; a FitFlex admin sets it.
// - ApiClientUsageDay: requests / errors / rate-limited per client per day (retention 90 days).
// - WebhookEndpoint (S1): adds the AES-256-GCM ciphertext of the signing secret (HMAC needs the raw key, so the S1
//   `secretHash` stays only as a fingerprint), its key id, the previous secret for rotation grace, verifiedAt (the
//   handshake), the events it is limited to, why it was disabled, and the consecutive-failure counter.
// - WebhookDelivery (S1): adds the lease (a claim without holding a transaction open during HTTP), the last attempt
//   time and the bounded manual-retry counter.
// - WebhookDeliveryAttempt: one row per attempt (auto, manual, test, verify) with a redacted response snippet. A
//   test or verification message has no delivery row, so deliveryId may be NULL.
//
// Additive. Down FAILS CLOSED: it refuses while any API client, usage row, endpoint-attempt row or enabled
// organizer exists, and on an empty module restores the S4 shape exactly.

const ENVIRONMENTS = ['live', 'sandbox'];
const DISABLED_REASONS = ['manual', 'auto_failures', 'endpoint_gone', 'admin'];
const TRIGGERS = ['auto', 'manual', 'test', 'verify'];
const OUTCOMES = ['success', 'http_error', 'timeout', 'network_error', 'tls_error', 'blocked_address', 'redirect_not_followed', 'organizer_mismatch', 'gone'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE "ApiClient"
    ADD COLUMN name text NOT NULL DEFAULT 'API client',
    ADD COLUMN environment text NOT NULL DEFAULT 'live',
    ADD COLUMN "eventIds" jsonb,
    ADD COLUMN "createdBy" text REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD COLUMN "secretVersion" integer NOT NULL DEFAULT 1,
    ADD COLUMN "previousSecretHash" text,
    ADD COLUMN "previousSecretExpiresAt" timestamptz,
    ADD COLUMN "rateLimitPerMinute" integer NOT NULL DEFAULT 120,
    ADD COLUMN "failedAttempts" integer NOT NULL DEFAULT 0,
    ADD COLUMN "lockedUntil" timestamptz`);
  await knex.raw(`ALTER TABLE "ApiClient"
    ADD CONSTRAINT apiclient_environment_check CHECK (environment IN (${list(ENVIRONMENTS)})),
    ADD CONSTRAINT apiclient_event_ids_check CHECK ("eventIds" IS NULL OR jsonb_typeof("eventIds") = 'array'),
    ADD CONSTRAINT apiclient_rate_check CHECK ("rateLimitPerMinute" BETWEEN 1 AND 600),
    ADD CONSTRAINT apiclient_name_check CHECK (char_length(name) BETWEEN 1 AND 60),
    ADD CONSTRAINT apiclient_secret_version_check CHECK ("secretVersion" >= 1),
    ADD CONSTRAINT apiclient_previous_secret_check CHECK (("previousSecretHash" IS NULL) = ("previousSecretExpiresAt" IS NULL))`);

  await knex.raw(`ALTER TABLE "EventOrganizer" ADD COLUMN "apiAccessEnabledAt" timestamptz`);

  await knex.schema.createTable('ApiClientUsageDay', (t) => {
    t.text('id').primary();
    t.text('apiClientId').notNullable().references('id').inTable('ApiClient').onDelete('CASCADE').onUpdate('CASCADE');
    t.date('day').notNullable();
    t.integer('requests').notNullable().defaultTo(0);
    t.integer('errors').notNullable().defaultTo(0);
    t.integer('rateLimited').notNullable().defaultTo(0);
    t.unique(['apiClientId', 'day']);
  });

  await knex.raw(`ALTER TABLE "WebhookEndpoint"
    ADD COLUMN description text,
    ADD COLUMN "secretCiphertext" text,
    ADD COLUMN "secretKeyId" text,
    ADD COLUMN "secretLast4" text,
    ADD COLUMN "previousSecretCiphertext" text,
    ADD COLUMN "previousSecretKeyId" text,
    ADD COLUMN "previousSecretExpiresAt" timestamptz,
    ADD COLUMN "verifiedAt" timestamptz,
    ADD COLUMN "eventIds" jsonb,
    ADD COLUMN "disabledReason" text,
    ADD COLUMN "disabledAt" timestamptz,
    ADD COLUMN "consecutiveFailures" integer NOT NULL DEFAULT 0,
    ADD COLUMN "firstFailureAt" timestamptz,
    ADD COLUMN "createdBy" text REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE`);
  await knex.raw(`ALTER TABLE "WebhookEndpoint"
    ADD CONSTRAINT webhookendpoint_event_ids_check CHECK ("eventIds" IS NULL OR jsonb_typeof("eventIds") = 'array'),
    ADD CONSTRAINT webhookendpoint_disabled_reason_check CHECK ("disabledReason" IS NULL OR "disabledReason" IN (${list(DISABLED_REASONS)})),
    ADD CONSTRAINT webhookendpoint_previous_secret_check CHECK (("previousSecretCiphertext" IS NULL) = ("previousSecretExpiresAt" IS NULL))`);

  await knex.raw(`ALTER TABLE "WebhookDelivery"
    ADD COLUMN "leaseUntil" timestamptz,
    ADD COLUMN "lastAttemptAt" timestamptz,
    ADD COLUMN "manualRetryCount" integer NOT NULL DEFAULT 0`);
  await knex.raw(`CREATE INDEX webhookdelivery_due_idx ON "WebhookDelivery" ("nextAttemptAt") WHERE status IN ('pending', 'failed')`);

  await knex.schema.createTable('WebhookDeliveryAttempt', (t) => {
    t.text('id').primary();
    t.text('deliveryId').references('id').inTable('WebhookDelivery').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('endpointId').notNullable().references('id').inTable('WebhookEndpoint').onDelete('RESTRICT').onUpdate('CASCADE');
    t.integer('attemptNo').notNullable().defaultTo(1);
    t.text('trigger').notNullable().defaultTo('auto');
    t.timestamp('startedAt', { precision: 3 }).notNullable().defaultTo(knex.fn.now());
    t.integer('durationMs');
    t.text('outcome').notNullable();
    t.integer('responseCode');
    t.text('responseSnippet');
    t.text('errorCode');
    t.timestamp('nextAttemptAt', { precision: 3 });
    t.index(['deliveryId', 'attemptNo']);
    t.index(['endpointId', 'startedAt']);
  });
  await knex.raw(`ALTER TABLE "WebhookDeliveryAttempt"
    ADD CONSTRAINT webhookdeliveryattempt_trigger_check CHECK (trigger IN (${list(TRIGGERS)})),
    ADD CONSTRAINT webhookdeliveryattempt_outcome_check CHECK (outcome IN (${list(OUTCOMES)})),
    ADD CONSTRAINT webhookdeliveryattempt_snippet_check CHECK ("responseSnippet" IS NULL OR char_length("responseSnippet") <= 200)`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const count = async (sql) => Number((await knex.raw(sql)).rows[0].n);
  const blockers = [
    [await count(`SELECT count(*) AS n FROM "ApiClient"`), 'API clients exist'],
    [await count(`SELECT count(*) AS n FROM "ApiClientUsageDay"`), 'API usage rows exist'],
    [await count(`SELECT count(*) AS n FROM "WebhookDeliveryAttempt"`), 'webhook attempts exist'],
    [await count(`SELECT count(*) AS n FROM "WebhookEndpoint"`), 'webhook endpoints exist'],
    [await count(`SELECT count(*) AS n FROM "EventOrganizer" WHERE "apiAccessEnabledAt" IS NOT NULL`), 'organizers are enabled for the API'],
  ].filter(([n]) => n > 0).map(([, why]) => why);
  if (blockers.length) throw new Error(`events S5 integrations down refused (fails closed): ${blockers.join('; ')}.`);

  await knex.schema.dropTableIfExists('WebhookDeliveryAttempt');
  await knex.raw(`DROP INDEX IF EXISTS webhookdelivery_due_idx`);
  await knex.raw(`ALTER TABLE "WebhookDelivery" DROP COLUMN "manualRetryCount", DROP COLUMN "lastAttemptAt", DROP COLUMN "leaseUntil"`);
  await knex.raw(`ALTER TABLE "WebhookEndpoint"
    DROP CONSTRAINT webhookendpoint_previous_secret_check, DROP CONSTRAINT webhookendpoint_disabled_reason_check, DROP CONSTRAINT webhookendpoint_event_ids_check,
    DROP COLUMN "createdBy", DROP COLUMN "firstFailureAt", DROP COLUMN "consecutiveFailures", DROP COLUMN "disabledAt", DROP COLUMN "disabledReason",
    DROP COLUMN "eventIds", DROP COLUMN "verifiedAt", DROP COLUMN "previousSecretExpiresAt", DROP COLUMN "previousSecretKeyId",
    DROP COLUMN "previousSecretCiphertext", DROP COLUMN "secretLast4", DROP COLUMN "secretKeyId", DROP COLUMN "secretCiphertext", DROP COLUMN description`);
  await knex.schema.dropTableIfExists('ApiClientUsageDay');
  await knex.raw(`ALTER TABLE "EventOrganizer" DROP COLUMN "apiAccessEnabledAt"`);
  await knex.raw(`ALTER TABLE "ApiClient"
    DROP CONSTRAINT apiclient_previous_secret_check, DROP CONSTRAINT apiclient_secret_version_check, DROP CONSTRAINT apiclient_name_check,
    DROP CONSTRAINT apiclient_rate_check, DROP CONSTRAINT apiclient_event_ids_check, DROP CONSTRAINT apiclient_environment_check,
    DROP COLUMN "lockedUntil", DROP COLUMN "failedAttempts", DROP COLUMN "rateLimitPerMinute", DROP COLUMN "previousSecretExpiresAt",
    DROP COLUMN "previousSecretHash", DROP COLUMN "secretVersion", DROP COLUMN "createdBy", DROP COLUMN "eventIds", DROP COLUMN environment, DROP COLUMN name`);
};
