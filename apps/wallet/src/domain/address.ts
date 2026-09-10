/**
 * Her address book: the form she fills, and how one is read back out.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS MODULE EXISTS BECAUSE OF ONE PRODUCTION BUG IN SOMEBODY ELSE'S APP.
 *
 * `PRIOR-ART.md` § "The shop is delivery-based" records what AvoRewards' live
 * `src/components/address/addressDetail.js:110-140` does: the customer fills TWO
 * inputs — `houseNo` and `landMark` — and one of them is sent as FOUR different
 * address fields.
 *
 *     block:          data.houseNo,
 *     street:         data.landMark,
 *     buildingNumber: data.houseNo,
 *     floor:          data.houseNo,
 *     apartment:      data.houseNo,
 *     areaId: 1,  regionId: 1,
 *     jadda: 'string',  instructions: 'string',
 *
 * So a driver receives a house number in the block field, a landmark where the
 * street belongs, and the literal text `'string'` twice. Kuwaiti addresses are
 * genuinely block / street / building, and this is a real thing in production
 * that costs somebody real time on the day it matters.
 *
 * WHAT WE DO INSTEAD, and it is the whole content of this file:
 *
 *   collect the fields we intend to store, one input per field;
 *   send exactly those;
 *   and let a field be EMPTY rather than filling it with a copy of another
 *   field or a placeholder.
 *
 * `toAddressPayload` is the defence and it has no branch that could substitute
 * anything: every optional field's only two outcomes are the trimmed text she
 * typed and `null`. There is nowhere for a default to live. `address.test.ts`
 * asserts that against the whole field list rather than trusting the reading —
 * the brief's instruction, and the right one, because a fan-out bug looks
 * correct in the code that causes it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FOUR REQUIRED FIELDS, NOT THREE.
 *
 * The slice was briefed as "block, street, building are required". The API
 * requires a FOURTH — `label` — and the contract wins: `routes/addresses.ts`
 * runs `requireString(body.label, 'label', 60)` and `member_address` carries
 * `member_address_label_not_blank`. A form that treated the label as optional
 * would answer `invalid_request` at the boundary for a form that looked complete.
 *
 * It also earns its place: the label is Lean's `saveAs` and is what makes a book
 * REUSABLE — a second address with no name is indistinguishable from the first
 * in a chooser.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO GOOGLE PLACES, AND THEREFORE NO COORDINATES.
 *
 * Lean fills the structured parts from Places autocomplete and rides
 * `latitude`/`longitude` along with them. We collect the fields directly.
 *
 * That decision is NOT this lane's to take — a new external dependency with an
 * API key and a per-request cost is a client decision, and it has not been put
 * to Aftab — so the manual form is what exists, and the manual form is also what
 * a Places decision needs in order to be made at all: Places fills components,
 * and you cannot say which components it should fill until they exist as inputs.
 *
 * The consequence for the payload is exact and is why this is written down here:
 * **with no Places there is no source for a coordinate, so neither is sent.**
 * `latitude`/`longitude` are absent from `AddressPayload` entirely rather than
 * present-and-null, because both-or-neither is a database CHECK
 * (`member_address_coordinates_are_a_pair`) and the honest shape for "we have no
 * source" is a field this client cannot express. We do NOT prompt for the
 * device's location to manufacture a pair: a phone's GPS reading is where SHE is
 * standing, which on the day she orders from the office is not where the bottle
 * goes — a plausible wrong coordinate is worse than none, and is the same class
 * of mistake as `'string'`.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import type { MemberAddress } from '@avo/types';

/**
 * The four fields an address cannot be delivered without.
 *
 * A tuple rather than a `Set`, because the ORDER is the order the form draws
 * them in and the order a Kuwaiti address is written in — and because a test
 * that iterates it gets a stable list.
 */
export const ADDRESS_REQUIRED = ['label', 'block', 'street', 'building'] as const;

/**
 * Everything else. Mirrors `OPTIONAL` in `api/src/routes/addresses.ts` exactly,
 * in the same order, so a field added there and not here is visible as a
 * difference between two short lists rather than hidden in a form.
 */
export const ADDRESS_OPTIONAL = [
  'floor',
  'apartment',
  'area',
  'governorate',
  'instructions',
] as const;

export type AddressRequiredField = (typeof ADDRESS_REQUIRED)[number];
export type AddressOptionalField = (typeof ADDRESS_OPTIONAL)[number];
export type AddressField = AddressRequiredField | AddressOptionalField;

/** Every field, required first, in writing order. */
export const ADDRESS_FIELDS: readonly AddressField[] = [
  ...ADDRESS_REQUIRED,
  ...ADDRESS_OPTIONAL,
];

/**
 * The form's state: every field a STRING, including the optional ones.
 *
 * A `string | null` form state would put the null decision in nine places — one
 * per input's `onChangeText` — and `null` is exactly the value that must be
 * derived rather than typed. Here the inputs are uniformly strings and
 * `toAddressPayload` is the single place emptiness becomes `null`.
 */
export type AddressForm = Record<AddressField, string>;

/**
 * The maximum lengths the API enforces on the required four. Applied to the
 * inputs so she is stopped at the field rather than by a 400 after tapping Save.
 *
 * The five optional columns are `text` with NO cap in the route or the schema, so
 * the numbers below for those are this form's own restraint and not a contract
 * claim — a single-line component and a delivery note both want a ceiling, and
 * inventing one here is safer than a paragraph in `building`.
 */
export const ADDRESS_MAX_LENGTH: Record<AddressField, number> = {
  label: 60, // routes/addresses.ts
  block: 40, // routes/addresses.ts
  street: 120, // routes/addresses.ts
  building: 40, // routes/addresses.ts
  floor: 40, // ours
  apartment: 40, // ours
  area: 80, // ours
  governorate: 80, // ours
  instructions: 280, // ours
};

/** A blank form. Every field present and empty; nothing pre-filled. */
export function emptyAddressForm(): AddressForm {
  return {
    label: '',
    block: '',
    street: '',
    building: '',
    floor: '',
    apartment: '',
    area: '',
    governorate: '',
    instructions: '',
  };
}

/**
 * A saved address, back into the form, for editing.
 *
 * A `null` column becomes the empty string — the inverse of `toAddressPayload`,
 * so a round trip through the form does not invent text. It deliberately does
 * NOT carry `latitude`/`longitude`: the form cannot edit them (no Places), and
 * `PUT` is a whole-row replace of the editable parts, so an address that somehow
 * HAS a pair would lose it on an edit through this form.
 *
 * That is a real consequence and it is stated rather than hidden. Nothing in
 * this build can create a pair today — no surface sends one — so no live data
 * can lose one. If Places ever lands, this function and `toAddressPayload` are
 * the two places that have to learn about the pair, together, because the CHECK
 * is both-or-neither.
 */
export function formFromAddress(address: MemberAddress): AddressForm {
  return {
    label: address.label,
    block: address.block,
    street: address.street,
    building: address.building,
    floor: address.floor ?? '',
    apartment: address.apartment ?? '',
    area: address.area ?? '',
    governorate: address.governorate ?? '',
    instructions: address.instructions ?? '',
  };
}

/**
 * What the client sends. Required fields are strings; optional fields are
 * `string | null` with NO third possibility.
 *
 * `latitude`/`longitude` are ABSENT from this type — see the header. A key that
 * is not in the type cannot be filled in by a later edit to a call site.
 */
export type AddressPayload = Record<AddressRequiredField, string> &
  Record<AddressOptionalField, string | null>;

/**
 * The required fields she has not filled, in form order. Empty means submittable.
 *
 * Trims before judging, so a field holding a space is missing rather than
 * present — which is what the API decides too (`requireString` trims and then
 * refuses `''`), and the two must agree or the button enables for a form the
 * server refuses.
 */
export function missingAddressFields(form: AddressForm): AddressRequiredField[] {
  return ADDRESS_REQUIRED.filter((f) => form[f].trim() === '');
}

/**
 * The form, as the request body.
 *
 * THE ONE RULE: an empty optional field becomes `null`. Not the value of another
 * field, not a placeholder, not omitted-and-defaulted server-side. Read the
 * header for whose bug this is.
 *
 * Every value is trimmed, matching what the API stores — `normaliseOptional`
 * trims and maps `''` to NULL, `requireString` trims — so the body this sends is
 * byte-identical to what comes back from `GET`, and an edit form pre-filled from
 * the server does not show her different text from what she typed.
 */
export function toAddressPayload(form: AddressForm): AddressPayload {
  const required = Object.fromEntries(
    ADDRESS_REQUIRED.map((f) => [f, form[f].trim()]),
  ) as Record<AddressRequiredField, string>;

  const optional = Object.fromEntries(
    ADDRESS_OPTIONAL.map((f) => {
      const trimmed = form[f].trim();
      // The only two outcomes. There is no `else` for a default to hide in.
      return [f, trimmed === '' ? null : trimmed];
    }),
  ) as Record<AddressOptionalField, string | null>;

  return { ...required, ...optional };
}

/**
 * An address as lines of text, for a chooser row or an order's snapshot.
 *
 * NULLS ARE SKIPPED RATHER THAN RENDERED, which is the display half of the same
 * rule: an omitted floor produces no floor line, not "Floor —" and certainly not
 * the building number again. So the number of lines varies by address, and that
 * is the address being honest about what it knows.
 *
 * The LABEL IS NOT IN HERE. It is her name for the address ("Home", "Mum's"),
 * not part of it, and a chooser draws it as the row's title above these lines.
 * Merging the two would put "Home" into a driver's address.
 *
 * Structural rather than `MemberAddress`, so an order's snapshot — which is the
 * same fields minus `createdAt` — satisfies it without a cast.
 */
export interface AddressLike {
  block: string;
  street: string;
  building: string;
  floor: string | null;
  apartment: string | null;
  area: string | null;
  governorate: string | null;
  instructions: string | null;
}

/**
 * The address, most specific part first, as a driver reads it.
 *
 * `instructions` is deliberately NOT one of these lines. It is a note to a human
 * ("ring the bell twice"), not a component of the address, and a chooser row
 * that appended it would grow to three lines of prose for one saved address.
 * Callers that want it — the order snapshot — render it as its own labelled row.
 */
export function addressLines(
  address: AddressLike,
  labels: AddressComponentLabels,
): string[] {
  const lines: string[] = [];
  // Block, street, building: always present, always together, on one line.
  lines.push(
    `${labels.block} ${address.block} · ${labels.street} ${address.street} · ${labels.building} ${address.building}`,
  );

  // Floor and apartment share a line when both are known, and neither invents
  // the other when only one is.
  const inside = [
    address.floor === null ? null : `${labels.floor} ${address.floor}`,
    address.apartment === null ? null : `${labels.apartment} ${address.apartment}`,
  ].filter((x): x is string => x !== null);
  if (inside.length > 0) lines.push(inside.join(' · '));

  // Area and governorate, the same way.
  const where = [address.area, address.governorate].filter(
    (x): x is string => x !== null && x !== '',
  );
  if (where.length > 0) lines.push(where.join(', '));

  return lines;
}

/**
 * The four component words the lines above are built from, structurally, so this
 * module does not depend on the whole `Copy` interface — the same narrowing
 * `domain/names.ts` applies to entities, and for the same reason: a test fixture
 * can supply four strings.
 */
export interface AddressComponentLabels {
  block: string;
  street: string;
  building: string;
  floor: string;
  apartment: string;
}
