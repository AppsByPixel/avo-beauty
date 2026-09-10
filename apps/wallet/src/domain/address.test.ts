/**
 * The address form's spec — and the one assertion the slice was briefed to make
 * rather than to trust itself about.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS BEING TESTED, AND WHY IT IS TESTED THIS WAY.
 *
 * `PRIOR-ART.md` records AvoRewards' live address form fanning ONE input across
 * FOUR fields and shipping the literal text `'string'` in two more, so a driver
 * receives a house number in the block field. The instruction for this slice was
 * explicit: "If a field is empty, send it empty. Assert that in a test rather
 * than trusting yourself."
 *
 * So the central test below does not check three or four fields by hand. It
 * iterates `ADDRESS_OPTIONAL`, and for each one fills EVERY OTHER FIELD WITH A
 * DISTINCT MARKER — so a payload that substituted any other field's value for
 * the empty one fails by naming which field it stole from. A hand-written
 * `expect(payload.floor).toBeNull()` would pass against a bug that copied
 * `building` into `apartment`; this cannot.
 *
 * That is the difference between testing the property and testing the example.
 * The fan-out bug looks correct in the code that causes it, which is exactly why
 * the reading is not the evidence.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import type { MemberAddress } from '@avo/types';
import {
  ADDRESS_FIELDS,
  ADDRESS_MAX_LENGTH,
  ADDRESS_OPTIONAL,
  ADDRESS_REQUIRED,
  addressLines,
  emptyAddressForm,
  formFromAddress,
  missingAddressFields,
  toAddressPayload,
  type AddressForm,
} from './address';

/** A form with every field filled with its own name — so nothing is ambiguous. */
function markedForm(): AddressForm {
  const form = emptyAddressForm();
  for (const field of ADDRESS_FIELDS) form[field] = `VALUE-${field}`;
  return form;
}

const LABELS = {
  block: 'Block',
  street: 'Street',
  building: 'Building',
  floor: 'Floor',
  apartment: 'Apartment',
};

describe('the field lists', () => {
  /**
   * FOUR REQUIRED, NOT THREE. The slice was briefed as "block, street, building
   * are required"; the API requires `label` as well — `requireString(body.label,
   * 'label', 60)` plus `member_address_label_not_blank` — and the contract wins.
   * A form that treated the label as optional would answer `invalid_request` for
   * a form that looked complete.
   */
  it('requires exactly label, block, street and building', () => {
    expect([...ADDRESS_REQUIRED]).toEqual(['label', 'block', 'street', 'building']);
  });

  /**
   * The optional list must mirror `OPTIONAL` in `api/src/routes/addresses.ts`
   * exactly, in order. Pinned here so a field added on the API side and not here
   * is a failing test rather than a field the form silently never collects — and
   * therefore a field always stored NULL.
   */
  it('mirrors the API OPTIONAL list, in order', () => {
    expect([...ADDRESS_OPTIONAL]).toEqual([
      'floor',
      'apartment',
      'area',
      'governorate',
      'instructions',
    ]);
  });

  it('has a length cap and a blank slot for every field', () => {
    for (const field of ADDRESS_FIELDS) {
      expect(ADDRESS_MAX_LENGTH[field]).toBeGreaterThan(0);
      expect(emptyAddressForm()[field]).toBe('');
    }
    // Nine fields, no more and no fewer — a tenth in the form with no column is
    // data collected and thrown away.
    expect(ADDRESS_FIELDS).toHaveLength(9);
  });

  /** The four caps the API actually enforces, so the input stops her first. */
  it('matches the API max lengths on the required four', () => {
    expect(ADDRESS_MAX_LENGTH.label).toBe(60);
    expect(ADDRESS_MAX_LENGTH.block).toBe(40);
    expect(ADDRESS_MAX_LENGTH.street).toBe(120);
    expect(ADDRESS_MAX_LENGTH.building).toBe(40);
  });
});

describe('toAddressPayload — an empty field is sent empty', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE LOAD-BEARING TEST. Read the file header.
   *
   * For each optional field in turn: blank THAT ONE, mark every other field with
   * its own name, and require the result to be exactly `null`. Because every
   * other field holds a distinguishable value, a payload that substituted any of
   * them fails with a message naming the field it copied.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  for (const field of ADDRESS_OPTIONAL) {
    it(`sends ${field} as null when it is empty, and copies nothing into it`, () => {
      const form = markedForm();
      form[field] = '';
      const payload = toAddressPayload(form);

      expect(payload[field]).toBeNull();

      // And the marker check said out loud: it is not any other field's value,
      // not the empty string, and not a placeholder.
      for (const other of ADDRESS_FIELDS) {
        if (other === field) continue;
        expect(payload[field]).not.toBe(`VALUE-${other}`);
      }
      expect(payload[field]).not.toBe('');
      expect(payload[field]).not.toBe('string');
    });
  }

  /** The same, for whitespace. `requireString` and `normaliseOptional` both trim. */
  for (const field of ADDRESS_OPTIONAL) {
    it(`sends ${field} as null when it holds only whitespace`, () => {
      const form = markedForm();
      form[field] = '   ';
      expect(toAddressPayload(form)[field]).toBeNull();
    });
  }

  /**
   * ALL FIVE AT ONCE — the actual first-run shape, and the one the SQL proof in
   * this slice's report drives against a real database. A customer who fills the
   * required four and nothing else sends five nulls, not five copies of the
   * building number.
   */
  it('sends five nulls for a form with only the required four filled', () => {
    const form = emptyAddressForm();
    form.label = 'Home';
    form.block = '4';
    form.street = 'Salem Al Mubarak';
    form.building = '12';

    expect(toAddressPayload(form)).toEqual({
      label: 'Home',
      block: '4',
      street: 'Salem Al Mubarak',
      building: '12',
      floor: null,
      apartment: null,
      area: null,
      governorate: null,
      instructions: null,
    });
  });

  /**
   * NO COORDINATE KEYS AT ALL — not present-and-null. There is no Places
   * integration, so there is no source for a pair, and both-or-neither is a
   * database CHECK. A key absent from the payload cannot be filled in by a later
   * edit to a call site.
   */
  it('sends no latitude or longitude, in any form', () => {
    const payload = toAddressPayload(markedForm()) as Record<string, unknown>;
    expect('latitude' in payload).toBe(false);
    expect('longitude' in payload).toBe(false);
    // And nothing else beyond the nine, so a stray key cannot ride along.
    expect(Object.keys(payload).sort()).toEqual([...ADDRESS_FIELDS].sort());
  });

  it('trims every value, so what is stored is what comes back', () => {
    const form = emptyAddressForm();
    form.label = '  Home  ';
    form.block = ' 4 ';
    form.street = '  Salem  ';
    form.building = ' 12 ';
    form.floor = '  3  ';
    const payload = toAddressPayload(form);
    expect(payload.label).toBe('Home');
    expect(payload.block).toBe('4');
    expect(payload.street).toBe('Salem');
    expect(payload.building).toBe('12');
    expect(payload.floor).toBe('3');
  });
});

describe('missingAddressFields', () => {
  it('names all four on a blank form, in writing order', () => {
    expect(missingAddressFields(emptyAddressForm())).toEqual([
      'label',
      'block',
      'street',
      'building',
    ]);
  });

  it('is empty once the required four hold text', () => {
    const form = emptyAddressForm();
    form.label = 'Home';
    form.block = '4';
    form.street = 'Salem';
    form.building = '12';
    expect(missingAddressFields(form)).toEqual([]);
  });

  /**
   * A field holding a space is MISSING, and the two sides have to agree: the API
   * trims and then refuses `''`. If this said "present" the Save button would
   * enable for a form the server refuses.
   */
  it('treats a whitespace-only required field as missing', () => {
    const form = emptyAddressForm();
    form.label = ' ';
    form.block = '4';
    form.street = 'Salem';
    form.building = '12';
    expect(missingAddressFields(form)).toEqual(['label']);
  });

  it('never reports an optional field as missing', () => {
    const form = emptyAddressForm();
    for (const field of ADDRESS_REQUIRED) form[field] = 'x';
    expect(missingAddressFields(form)).toEqual([]);
  });
});

describe('formFromAddress — the inverse, and it invents no text', () => {
  const saved: MemberAddress = {
    id: 'ADR-1',
    label: 'Home',
    block: '4',
    street: 'Salem Al Mubarak',
    building: '12',
    floor: null,
    apartment: null,
    area: null,
    governorate: null,
    instructions: null,
    latitude: null,
    longitude: null,
    createdAt: '2026-09-10T09:00:00.000Z',
  };

  it('turns every null column into an empty input', () => {
    const form = formFromAddress(saved);
    for (const field of ADDRESS_OPTIONAL) expect(form[field]).toBe('');
    expect(form.label).toBe('Home');
  });

  /**
   * THE ROUND TRIP MUST BE IDENTITY. A saved address, read into the form and sent
   * straight back, produces the same nine values — so opening the edit sheet and
   * tapping Save without typing anything cannot change the row.
   *
   * `PUT` is a whole-row replace, so this is the property that stops an edit from
   * silently blanking a field the form failed to carry.
   */
  it('round-trips a fully populated address unchanged', () => {
    const full: MemberAddress = {
      ...saved,
      floor: '3',
      apartment: '12B',
      area: 'Salmiya',
      governorate: 'Hawalli',
      instructions: 'Ring twice',
    };
    expect(toAddressPayload(formFromAddress(full))).toEqual({
      label: 'Home',
      block: '4',
      street: 'Salem Al Mubarak',
      building: '12',
      floor: '3',
      apartment: '12B',
      area: 'Salmiya',
      governorate: 'Hawalli',
      instructions: 'Ring twice',
    });
  });

  it('round-trips an address with every optional field null', () => {
    expect(toAddressPayload(formFromAddress(saved))).toEqual({
      label: 'Home',
      block: '4',
      street: 'Salem Al Mubarak',
      building: '12',
      floor: null,
      apartment: null,
      area: null,
      governorate: null,
      instructions: null,
    });
  });
});

describe('addressLines — nulls are skipped, not rendered', () => {
  const base = {
    block: '4',
    street: 'Salem Al Mubarak',
    building: '12',
    floor: null,
    apartment: null,
    area: null,
    governorate: null,
    instructions: null,
  };

  it('renders one line when only the required three are known', () => {
    expect(addressLines(base, LABELS)).toEqual(['Block 4 · Street Salem Al Mubarak · Building 12']);
  });

  /** No "Floor —", and — the point — no second copy of the building number. */
  it('renders no floor line at all when the floor is null', () => {
    const lines = addressLines(base, LABELS).join('\n');
    expect(lines).not.toContain('Floor');
    expect(lines.match(/12/g)).toHaveLength(1);
  });

  it('puts floor and apartment on one line when both are known', () => {
    expect(addressLines({ ...base, floor: '3', apartment: '12B' }, LABELS)[1]).toBe(
      'Floor 3 · Apartment 12B',
    );
  });

  it('names only the one that is known when the other is null', () => {
    expect(addressLines({ ...base, floor: '3' }, LABELS)[1]).toBe('Floor 3');
    expect(addressLines({ ...base, apartment: '12B' }, LABELS)[1]).toBe('Apartment 12B');
  });

  it('joins area and governorate, and drops either when null', () => {
    expect(addressLines({ ...base, area: 'Salmiya', governorate: 'Hawalli' }, LABELS)[1]).toBe(
      'Salmiya, Hawalli',
    );
    expect(addressLines({ ...base, area: 'Salmiya' }, LABELS)[1]).toBe('Salmiya');
    expect(addressLines({ ...base, governorate: 'Hawalli' }, LABELS)[1]).toBe('Hawalli');
  });

  /**
   * THE LABEL IS NOT PART OF THE ADDRESS, and neither are the instructions. "Home"
   * is her name for it and a note is a note to a human; putting either into these
   * lines would put them into what a driver reads.
   */
  it('never renders the label or the instructions', () => {
    const lines = addressLines({ ...base, instructions: 'Ring twice' }, LABELS).join('\n');
    expect(lines).not.toContain('Ring twice');
    expect(lines).not.toContain('Home');
  });
});
