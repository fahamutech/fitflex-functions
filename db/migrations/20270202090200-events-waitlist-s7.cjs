// Marathon & running events · S7 (3 of 4) — the waitlist (REG-015).
// Design: docs/design/events-s7-hardening-and-pilot.md §4 (D70 to D76) and §7.3.
//
// RULE 6 AREA (owner reviews, D35): a waitlist offer is a REAL ORDER created by a system actor through the registration service; no store
// primitive, payment code or ledger rule changes. This migration only adds the queue:
//  - Event.waitlistEnabled (default true: new sign-ups allowed) and Event.waitlistClosedAt (the organizer closed the line for good).
//  - EventWaitlistEntry: one row per member per ticket type. `seq` is a database identity (first come, first offered, never clock time).
//    `intent` holds the registration details the member gave when joining so the offer needs nothing more; it is cleared within 24 hours of
//    the entry ending, and the row is deleted with the account (ON DELETE CASCADE).
//  - Two partial unique indexes keep one LIVE entry per member and one per contact (phone or email hash) per ticket type.
//
// Additive. Down FAILS CLOSED once any entry exists.

const STATUSES = ['waiting', 'offered', 'converted', 'expired', 'declined', 'left', 'removed', 'closed'];
const ENDED_REASONS = ['sale_closed', 'event_cancelled', 'organizer_closed', 'registered_elsewhere', 'not_eligible', 'offer_expired', 'offer_declined', 'paid', 'left', 'removed'];
const list = values => values.map(v => `'${v}'`).join(', ');

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE "Event" ADD COLUMN "waitlistEnabled" boolean NOT NULL DEFAULT true, ADD COLUMN "waitlistClosedAt" timestamp(3) with time zone`);

  await knex.raw(`CREATE TABLE "EventWaitlistEntry" (
    id text PRIMARY KEY,
    "eventId" text NOT NULL,
    "categoryId" text NOT NULL,
    "ticketTypeId" text NOT NULL,
    "userId" text NOT NULL REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE,
    seq bigint GENERATED ALWAYS AS IDENTITY,
    status text NOT NULL DEFAULT 'waiting',
    quantity smallint NOT NULL DEFAULT 1,
    intent jsonb,
    "consentTextVersion" text NOT NULL,
    "contactKey" text NOT NULL,
    "blockedReason" text,
    "skipCount" smallint NOT NULL DEFAULT 0,
    "joinedAt" timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "offeredAt" timestamp(3) with time zone,
    "offerExpiresAt" timestamp(3) with time zone,
    "remindedAt" timestamp(3) with time zone,
    "orderId" text REFERENCES "EventOrder"(id) ON UPDATE CASCADE ON DELETE SET NULL,
    "endedAt" timestamp(3) with time zone,
    "endedReason" text,
    "createdAt" timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT eventwaitlistentry_event_fk FOREIGN KEY ("eventId") REFERENCES "Event"(id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT eventwaitlistentry_category_fk FOREIGN KEY ("categoryId", "eventId") REFERENCES "EventCategory"(id, "eventId") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT eventwaitlistentry_ticket_type_fk FOREIGN KEY ("ticketTypeId", "eventId") REFERENCES "EventTicketType"(id, "eventId") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT eventwaitlistentry_status_check CHECK (status IN (${list(STATUSES)})),
    CONSTRAINT eventwaitlistentry_quantity_check CHECK (quantity = 1),
    CONSTRAINT eventwaitlistentry_blocked_check CHECK ("blockedReason" IS NULL OR "blockedReason" = 'reconsent'),
    CONSTRAINT eventwaitlistentry_reason_check CHECK ("endedReason" IS NULL OR "endedReason" IN (${list(ENDED_REASONS)})),
    CONSTRAINT eventwaitlistentry_offered_check CHECK (status <> 'offered' OR ("offeredAt" IS NOT NULL AND "orderId" IS NOT NULL)),
    CONSTRAINT eventwaitlistentry_ended_check CHECK ((status IN ('waiting', 'offered')) = ("endedAt" IS NULL)),
    CONSTRAINT eventwaitlistentry_skip_check CHECK ("skipCount" >= 0)
  )`);
  await knex.raw(`CREATE UNIQUE INDEX eventwaitlistentry_live_user_unique ON "EventWaitlistEntry" ("userId", "ticketTypeId") WHERE status IN ('waiting', 'offered')`);
  await knex.raw(`CREATE UNIQUE INDEX eventwaitlistentry_live_contact_unique ON "EventWaitlistEntry" ("ticketTypeId", "contactKey") WHERE status IN ('waiting', 'offered')`);
  await knex.raw(`CREATE UNIQUE INDEX eventwaitlistentry_seq_unique ON "EventWaitlistEntry" (seq)`);
  await knex.raw(`CREATE INDEX eventwaitlistentry_queue_idx ON "EventWaitlistEntry" ("ticketTypeId", status, seq)`);
  await knex.raw(`CREATE INDEX eventwaitlistentry_user_idx ON "EventWaitlistEntry" ("userId", status)`);
  await knex.raw(`CREATE INDEX eventwaitlistentry_order_idx ON "EventWaitlistEntry" ("orderId") WHERE "orderId" IS NOT NULL`);
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  const n = Number((await knex.raw(`SELECT count(*) AS n FROM "EventWaitlistEntry"`)).rows[0].n);
  if (n > 0) throw new Error('events S7 waitlist down refused (fails closed): waitlist entries exist.');
  await knex.raw(`DROP TABLE "EventWaitlistEntry"`);
  await knex.raw(`ALTER TABLE "Event" DROP COLUMN "waitlistClosedAt", DROP COLUMN "waitlistEnabled"`);
};
