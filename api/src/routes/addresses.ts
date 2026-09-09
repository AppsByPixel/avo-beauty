/**
 * THE MEMBER'S SAVED ADDRESS BOOK.   (item 7, PRIOR-ART.md § Lean's shop)
 *
 * Lean's addresses belong to a `userId`, not to an order, and are named so they
 * can be reused. Same here: `member_address` is hers, `requireMember` is the
 * gate, and no route in this file takes a member id — the principal IS the
 * member, so one customer cannot read or edit another's addresses even by id.
 *
 * WHAT THIS FILE COLLECTS, AND WHY IT LOOKS PEDANTIC. Lean's `addressDetail.js`
 * collects TWO inputs and sends one of them as four different address fields,
 * puts the landmark where the street belongs, hardcodes `areaId`/`regionId` to 1,
 * and ships the literal text `'string'` in two more. A driver then receives a
 * house number in the block field.
 *
 * So: `block`, `street` and `building` are REQUIRED because an address missing
 * any of them cannot be delivered to. Everything else is optional and stored
 * exactly as given — and a field the customer left empty is stored as NULL, never
 * as a copy of another field and never as a placeholder. `normaliseOptional`
 * below is the whole defence, and it is three lines.
 *
 * NO DELIVERY FEE ANYWHERE IN THIS FEATURE, so nothing here is a money endpoint:
 * no idempotency key (non-negotiable #4 covers money-moving POSTs and this moves
 * none), no transaction around a single INSERT.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client';
import { memberAddress } from '../db/schema/delivery';
import { requireMember } from '../auth/principal';
import { badRequest, notFound } from '../http/errors';
import { requireString } from '../money/validate';

/** The optional components, in the order a Kuwaiti address is written. */
const OPTIONAL = ['floor', 'apartment', 'area', 'governorate', 'instructions'] as const;

/**
 * An absent or blank optional field becomes NULL. THE POINT OF THIS FUNCTION is
 * that it has no other branch: there is nowhere for it to substitute a default, a
 * placeholder, or the value of a different field, which is precisely what Lean
 * does and what a driver pays for.
 */
function normaliseOptional(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw badRequest('invalid_address_field', `${field} must be a string or omitted.`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * `numeric(9,6)` in the database, so it arrives back as a STRING and is sent as
 * one. Both or neither — `member_address_coordinates_are_a_pair` is the control;
 * this is the message.
 */
function parseCoordinates(body: Record<string, unknown>): {
  latitude: string | null;
  longitude: string | null;
} {
  const has = (k: string) => body[k] !== undefined && body[k] !== null;
  if (has('latitude') !== has('longitude')) {
    throw badRequest(
      'coordinates_incomplete',
      'latitude and longitude must be sent together, or neither.',
    );
  }
  if (!has('latitude')) return { latitude: null, longitude: null };

  const read = (k: string, min: number, max: number) => {
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw badRequest('invalid_coordinates', `${k} must be a number between ${min} and ${max}.`);
    }
    return n.toFixed(6);
  };
  return { latitude: read('latitude', -90, 90), longitude: read('longitude', -180, 180) };
}

export function serialiseAddress(row: typeof memberAddress.$inferSelect) {
  return {
    id: row.id,
    label: row.label,
    block: row.block,
    street: row.street,
    building: row.building,
    floor: row.floor,
    apartment: row.apartment,
    area: row.area,
    governorate: row.governorate,
    instructions: row.instructions,
    /** Strings, because `numeric` is exact and a float round-trip is not. */
    latitude: row.latitude,
    longitude: row.longitude,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function registerAddressRoutes(app: FastifyInstance): Promise<void> {
  /** Her book. Soft-deleted rows are gone from it; an old order still names them. */
  app.get('/members/me/addresses', async (req, reply) => {
    const p = requireMember(req);
    const rows = await db
      .select()
      .from(memberAddress)
      .where(and(eq(memberAddress.memberId, p.id), isNull(memberAddress.deletedAt)))
      .orderBy(desc(memberAddress.createdAt));
    return reply.send({ items: rows.map(serialiseAddress), nextCursor: null });
  });

  app.post('/members/me/addresses', async (req, reply) => {
    const p = requireMember(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    /**
     * REFUSED BY NAME, not ignored. `memberId` in the body means the client
     * believed it was choosing whose address book this lands in — the same
     * treatment `POST /orders` gives a price and `POST /bookings` gives a branch.
     */
    if ('memberId' in body) {
      throw badRequest(
        'member_not_client_supplied',
        'An address belongs to the signed-in customer, not to a memberId in the request.',
      );
    }

    const values = {
      id: `ADR-${randomUUID()}`,
      memberId: p.id,
      label: requireString(body.label, 'label', 60).trim(),
      block: requireString(body.block, 'block', 40).trim(),
      street: requireString(body.street, 'street', 120).trim(),
      building: requireString(body.building, 'building', 40).trim(),
      ...Object.fromEntries(
        OPTIONAL.map((f) => [f, normaliseOptional(body[f], f)]),
      ),
      ...parseCoordinates(body),
    } as typeof memberAddress.$inferInsert;

    for (const f of ['label', 'block', 'street', 'building'] as const) {
      if (values[f].trim() === '') {
        throw badRequest('blank_address_field', `${f} cannot be blank.`);
      }
    }

    const [row] = await db.insert(memberAddress).values(values).returning();
    return reply.code(201).send({ address: serialiseAddress(row!) });
  });

  /**
   * A whole-row replace of the editable parts, so an omitted optional field
   * becomes NULL rather than keeping its old value. That is the honest shape for
   * this table: the alternative — merge on present keys — makes "clear the
   * instructions" unexpressible without a sentinel, and a sentinel is how
   * `'string'` gets stored.
   */
  app.put<{ Params: { id: string } }>('/members/me/addresses/:id', async (req, reply) => {
    const p = requireMember(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const [target] = await db
      .select()
      .from(memberAddress)
      .where(
        and(
          eq(memberAddress.id, req.params.id),
          eq(memberAddress.memberId, p.id),
          isNull(memberAddress.deletedAt),
        ),
      )
      .limit(1);
    // Scoped to her in the WHERE, so another customer's id is a 404 and not a
    // 403 — a 403 would confirm the address exists.
    if (!target) throw notFound('unknown_address', 'No such address.');

    const [row] = await db
      .update(memberAddress)
      .set({
        label: requireString(body.label, 'label', 60).trim(),
        block: requireString(body.block, 'block', 40).trim(),
        street: requireString(body.street, 'street', 120).trim(),
        building: requireString(body.building, 'building', 40).trim(),
        ...Object.fromEntries(OPTIONAL.map((f) => [f, normaliseOptional(body[f], f)])),
        ...parseCoordinates(body),
        updatedAt: new Date(),
      })
      .where(eq(memberAddress.id, target.id))
      .returning();

    return reply.send({ address: serialiseAddress(row!) });
  });

  /**
   * SOFT DELETE. An order already placed to this address snapshotted it, so the
   * driver is unaffected either way — but `shop_order.address_id` is
   * `ON DELETE restrict`, so a hard delete would refuse for exactly the
   * addresses that have been used. Soft is the shape that works for both.
   *
   * The transition is the WHERE clause and the row count decides, so a second
   * DELETE is a 404 rather than a silent success.
   */
  app.delete<{ Params: { id: string } }>('/members/me/addresses/:id', async (req, reply) => {
    const p = requireMember(req);
    const now = new Date();
    const removed = await db
      .update(memberAddress)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(memberAddress.id, req.params.id),
          eq(memberAddress.memberId, p.id),
          isNull(memberAddress.deletedAt),
        ),
      )
      .returning({ id: memberAddress.id });
    if (!removed[0]) throw notFound('unknown_address', 'No such address.');
    return reply.code(204).send();
  });
}
