/**
 * The legal set and the support configuration — api-contract.md
 * § LegalDocumentSet and § SupportConfig.
 *
 * NON-NEGOTIABLE #10: "The customer app holds no legal copy. It renders the
 * published policy set from the API and stamps the version. Store the accepted
 * version against the member."
 *
 * The member half has existed since the first migration — `member.policyVersion`
 * is NOT NULL with a `> 0` CHECK. This is the half it points AT, which did not
 * exist, so every member row carried a version referring to a document set the
 * API could not produce and the wallet's Terms screen rendered nothing.
 *
 * EVERY PUBLISHED VERSION IS KEPT, and `version` is the primary key. A single
 * mutable row would strand `member.policyVersion` the moment anything was
 * republished, and would do it precisely in the case the stamp exists for: a
 * dispute about wording somebody agreed to two versions ago. A publish INSERTs;
 * nothing here is updated afterwards.
 *
 * NON-NEGOTIABLE #11 lives on `supportTopic.route`: routing is resolved
 * server-side from `topicId`, so the route is a property of the topic, owned by
 * AVO, and never read from a request body.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';
import { member } from './member';
import { salon } from './salon';
import { transaction } from './transaction';

/** api-contract.md § LegalDocumentSet → LegalDoc. */
export interface LegalDoc {
  id: string;
  scope: 'platform' | 'wallet';
  /** Linked at signup; blocks account creation until accepted. */
  consent: boolean;
  title: { en: string; ar: string };
  /** One string per clause, rendered in order. */
  body: { en: string[]; ar: string[] };
}

export const legalDocumentSet = pgTable(
  'legal_document_set',
  {
    /** What `member.policyVersion` refers to. INSERT-only. */
    version: integer('version').primaryKey(),
    effectiveFrom: date('effective_from').notNull(),
    publishedAt: timestamptz('published_at').notNull(),
    publishedBy: text('published_by').notNull(),
    /**
     * One jsonb column for the reason `salon.tiers` is one: a publish is a
     * single row write and cannot half-apply. A half-published tier ladder is a
     * money bug; a half-published legal set is a customer reading clause 3 of
     * the old terms beside clause 4 of the new ones.
     */
    docs: jsonb('docs').$type<LegalDoc[]>().notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('legal_document_set_version_positive', sql`${t.version} > 0`),
    // An empty published set would satisfy every consent check trivially.
    check('legal_document_set_has_documents', sql`jsonb_array_length(${t.docs}) > 0`),
  ],
);

/**
 * THE DRAFT. One mutable row, and the asymmetry with the table above is the point.
 *
 * Published versions are INSERT-only and kept forever, because
 * `member.policy_version` points at one and a dispute is about wording somebody
 * agreed to two versions ago. A draft is a scratchpad: nobody has agreed to it,
 * nothing references it, and its history is not evidence. So it is edited in place
 * and `POST /v1/platform/policies/discard` resets it to the published set.
 *
 * ITS ABSENCE IS WHY #10's RE-PROMPT WAS ONLY EVER REACHABLE FROM SQL. STATUS.md
 * records that a previous session "inserted v4 by SQL to test the stale path" —
 * which is the tell: with no publish endpoint, the one behaviour #10's second half
 * describes could be exercised in a test and not in the product. Migration 0030.
 *
 * An EMPTY draft is legitimate and means "no unpublished changes".
 * `legal_document_set` has the opposite CHECK, because an empty PUBLISHED set
 * would satisfy every consent check trivially — one of the two tables is in front
 * of customers.
 */
export const legalDocumentDraft = pgTable(
  'legal_document_draft',
  {
    id: text('id').primaryKey().default('avo'),
    docs: jsonb('docs').$type<LegalDoc[]>().notNull().default([]),
    /** The console's "unpublished changes by …". Not an audit trail; that is audit_log. */
    updatedBy: text('updated_by'),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('legal_document_draft_is_singleton', sql`${t.id} = 'avo'`),
    check('legal_document_draft_docs_is_array', sql`jsonb_typeof(${t.docs}) = 'array'`),
  ],
);

/**
 * AVO's support channels. One row.
 *
 * "AVO owns this, not the salon — a merchant cannot point customers at an
 * unmonitored number." The singleton CHECK is the structural half of that.
 */
export const supportConfig = pgTable(
  'support_config',
  {
    id: text('id').primaryKey().default('avo'),
    /** E.164, shown LTR in both languages. */
    whatsapp: text('whatsapp').notNull(),
    email: text('email').notNull(),
    hoursEn: text('hours_en').notNull(),
    hoursAr: text('hours_ar').notNull(),
    /** The reply-time promise on the confirmation screen. */
    replyEn: text('reply_en').notNull(),
    replyAr: text('reply_ar').notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [check('support_config_is_singleton', sql`${t.id} = 'avo'`)],
);

export const supportTopic = pgTable(
  'support_topic',
  {
    id: text('id').primaryKey(),
    /**
     * WHICH QUEUE A MESSAGE LANDS IN. Non-negotiable #11's actual subject.
     *
     * A salon that could edit this would be able to route "a charge I do not
     * recognise" to itself — answering the disputes it is the subject of.
     */
    route: text('route').$type<'salon' | 'avo'>().notNull(),
    en: text('en').notNull(),
    ar: text('ar').notNull(),
    /** "rendered in array order" — api-contract.md § SupportConfig. */
    position: integer('position').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('support_topic_position_uq').on(t.position),
    check('support_topic_route_is_known', sql`${t.route} IN ('salon', 'avo')`),
  ],
);

export const supportTicket = pgTable(
  'support_ticket',
  {
    /** "SUP-48263". Rule 4: "the only handle the customer has." */
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => member.id, { onDelete: 'restrict' }),
    salonId: text('salon_id')
      .notNull()
      .references(() => salon.id, { onDelete: 'restrict' }),
    topicId: text('topic_id')
      .notNull()
      .references(() => supportTopic.id, { onDelete: 'restrict' }),

    /**
     * Resolved from the topic ON THE SERVER, and SNAPSHOTTED rather than
     * joined. AVO may re-route a topic later; a ticket that silently changed
     * queue afterwards would be a customer's dispute changing hands with no
     * record of it. Same instinct as `audit_log`'s actor columns.
     */
    route: text('route').$type<'salon' | 'avo'>().notNull(),

    message: text('message').notNull(),
    /** An optional receipt reference the customer attached. */
    ref: text('ref').notNull().default(''),
    /**
     * Rule 3: a `ref` matching a Transaction is linked, because "support
     * answering a dispute needs the receipt". Null when it matches nothing,
     * which is most of the time.
     */
    transactionId: text('transaction_id').references(() => transaction.id, {
      onDelete: 'set null',
    }),

    /** The reply channel the customer chose. */
    via: text('via').$type<'wa' | 'email'>().notNull(),
    status: text('status').$type<'open' | 'closed'>().notNull().default('open'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('support_ticket_member_created_idx').on(t.memberId, t.createdAt.desc()),
    index('support_ticket_route_status_idx').on(t.route, t.status, t.createdAt.desc()),
    check('support_ticket_route_is_known', sql`${t.route} IN ('salon', 'avo')`),
    check('support_ticket_via_is_known', sql`${t.via} IN ('wa', 'email')`),
    check('support_ticket_status_is_known', sql`${t.status} IN ('open', 'closed')`),
  ],
);
