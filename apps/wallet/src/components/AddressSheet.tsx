/**
 * The address form — nine inputs, four of them required.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NOT IN THE DESIGN BUNDLE. There is no delivery UI drawn anywhere in `design/`:
 * the shop was collection-only when the bundle was made, the wallet's receipt
 * row says "Pickup", and `shopSub` says "pick up at the salon".
 *
 * So this sheet BORROWS from the two form surfaces that do exist rather than
 * inventing a second visual language — `CLAUDE.md` forbids restyling and this is
 * the same instruction from the other side. Every piece of furniture here is
 * already in the app:
 *
 *   `Sheet`                  the bottom sheet, with its grabber and its four
 *                            dismissal exits (Esc, Android back, web back, the
 *                            backdrop) — `useDismissible` owns all four.
 *   `FieldLabel` / `Field`   the micro-label and the input from the ACCOUNT
 *                            sheets (`components/account/Fields.tsx`), including
 *                            the `(optional)` suffix treatment the design draws
 *                            at :786 and :829.
 *   `InlineError`            the same one-line danger banner sign-in, signup and
 *                            the three account sheets use.
 *   `PrimaryButton`          `brandDeep`, because its text is white (#9).
 *
 * Reusing `components/account/Fields.tsx` from outside `account/` is deliberate
 * and is the lesser of the two available mistakes: the alternative is a second
 * copy of an input, which is how two form surfaces in one app come to disagree
 * about a border radius. It is form furniture rather than account furniture, and
 * if a third surface needs it the honest move is to move the file up a level —
 * still inside this lane's column.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THE FIELDS ARE LAID OUT LIKE THIS, WHICH IS THE POINT OF THE SLICE.
 *
 * `PRIOR-ART.md` § "The shop is delivery-based" records AvoRewards' live form:
 * TWO inputs, `houseNo` and `landMark`, one of which is sent as FOUR different
 * address fields, with the landmark written where the street belongs and the
 * literal text `'string'` shipped in two more. A driver gets a house number in
 * the block field.
 *
 * The fix is not clever. It is ONE INPUT PER FIELD WE STORE, and an empty field
 * stored empty. That makes this form longer than Lean's — nine inputs against
 * two — and the length is the feature: there is no input here whose value fans
 * out, because every input has exactly one destination.
 *
 * The required four come first, unlabelled as required; the optional five come
 * under one sentence saying to leave what she does not need blank
 * (`addrOptionalNote`). That sentence is the customer-facing half of storing
 * NULL, and it is why the `(optional)` suffix appears on five labels and not on
 * nine — an "optional" marker on everything says nothing.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO GOOGLE PLACES, AND NO GEOLOCATION PROMPT.
 *
 * Lean fills the structured parts from Places autocomplete. We do not, and that
 * is a REPORTED OMISSION rather than a decision taken here: a new external
 * dependency with an API key and a per-request cost is not a lane's call, and it
 * has not been put to Aftab. Lane A left component resolution as "the client's
 * half"; this is the client's half done manually.
 *
 * The consequence, and the thing not to fix locally: with no Places there is no
 * source for `latitude`/`longitude`, so this form collects and sends NEITHER.
 * `AddressPayload` has no coordinate field at all, and there is deliberately no
 * "use my current location" button — a phone's GPS reading is where SHE is
 * standing, which on the day she orders from the office is not where the bottle
 * goes. A plausible wrong coordinate is the same class of mistake as `'string'`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FOUR STATES.
 *
 *   idle       the form. Save is enabled once the required four are non-blank.
 *   busy       Save disabled, label unchanged. No spinner: the write is one
 *              INSERT and the sheet closes on success, so a spinner would flash.
 *   refused    `InlineError`, announced through `accessibilityLiveRegion` — the
 *              required-fields sentence, or what the server said.
 *   offline    its own sentence, because the OUTCOME IS UNKNOWN. The POST may
 *              have landed. It does not say "try again", and `useAddresses`
 *              re-reads the book rather than assuming either way.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { MemberAddress } from '@avo/types';
import { useLanguage } from '../i18n/language';
import {
  ADDRESS_MAX_LENGTH,
  ADDRESS_OPTIONAL,
  ADDRESS_REQUIRED,
  emptyAddressForm,
  formFromAddress,
  missingAddressFields,
  toAddressPayload,
  type AddressField,
  type AddressForm,
} from '../domain/address';
import type { AddressPayload } from '../domain/address';
import type { AddressWriteError } from '../state/useAddresses';
import { Field, FieldLabel, InlineError } from './account/Fields';
import { PrimaryButton } from './Buttons';
import { Sheet } from './Sheet';
import { color, text } from '../theme';

interface Props {
  open: boolean;
  /**
   * `null` is a NEW address; a row is an edit. The only distinction, and it is
   * the caller's — there is no heuristic here about "does this look new".
   */
  editing: MemberAddress | null;
  busy: boolean;
  writeError: AddressWriteError | null;
  onClose: () => void;
  onSave: (payload: AddressPayload, id: string | null) => void;
}

export function AddressSheet({ open, editing, busy, writeError, onClose, onSave }: Props) {
  const { lang, copy } = useLanguage();
  const [form, setForm] = useState<AddressForm>(emptyAddressForm);
  /**
   * Only shown AFTER a Save attempt, never while she is still typing. A
   * validation message that appears as soon as a field is touched tells her she
   * has made a mistake before she has finished making it.
   */
  const [attempted, setAttempted] = useState(false);

  /*
    The form is seeded from the row when the sheet opens, and reset when it opens
    blank. Keyed on `open` as well as on the row so that closing and reopening on
    the SAME address discards an abandoned edit rather than resuming it — an
    address book is not a draft surface, and a half-typed street left over from
    last time is worse than an empty field.
  */
  useEffect(() => {
    if (!open) return;
    setForm(editing === null ? emptyAddressForm() : formFromAddress(editing));
    setAttempted(false);
  }, [open, editing]);

  const missing = missingAddressFields(form);
  const incomplete = missing.length > 0;

  const submit = () => {
    setAttempted(true);
    if (incomplete) return;
    onSave(toAddressPayload(form), editing?.id ?? null);
  };

  /** The label for a field, with the `(optional)` suffix on the five that are. */
  const labelFor = (field: AddressField): string => copy[LABEL_KEY[field]];

  return (
    <Sheet
      open={open}
      dismissible={!busy}
      onDismiss={onClose}
      label={editing === null ? copy.addressFormNewTitle : copy.addressFormEditTitle}
      testID="address-sheet"
    >
      <Text style={[text('displayS', lang), styles.title]}>
        {editing === null ? copy.addressFormNewTitle : copy.addressFormEditTitle}
      </Text>

      <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
        {/* ---------------------------------------------- the required four -- */}
        {ADDRESS_REQUIRED.map((field) => (
          <View key={field}>
            <FieldLabel>{labelFor(field)}</FieldLabel>
            <Field
              value={form[field]}
              onChangeText={(value) => setForm((f) => ({ ...f, [field]: value }))}
              maxLength={ADDRESS_MAX_LENGTH[field]}
              accessibilityLabel={labelFor(field)}
              testID={`address-field-${field}`}
            />
          </View>
        ))}

        {/*
          ONE SENTENCE, ABOVE THE OPTIONAL FIVE. The whole feature turns on it:
          a field she leaves blank is STORED blank, and is not filled with a copy
          of another field or a placeholder. See the header for whose bug that is.
        */}
        <Text style={[text('bodyS', lang), styles.note]} testID="address-optional-note">
          {copy.addrOptionalNote}
        </Text>

        {/* ---------------------------------------------- the optional five -- */}
        {ADDRESS_OPTIONAL.map((field) => (
          <View key={field}>
            <FieldLabel hint={copy.addrOptional}>{labelFor(field)}</FieldLabel>
            <Field
              value={form[field]}
              onChangeText={(value) => setForm((f) => ({ ...f, [field]: value }))}
              maxLength={ADDRESS_MAX_LENGTH[field]}
              /* A note to a human, so it gets room to be a sentence. */
              {...(field === 'instructions'
                ? { multiline: true, placeholder: copy.addrInstructionsPh }
                : {})}
              accessibilityLabel={`${labelFor(field)} ${copy.addrOptional}`}
              testID={`address-field-${field}`}
            />
          </View>
        ))}

        {/*
          NO COORDINATE FIELDS AND NO "USE MY LOCATION" BUTTON. Their absence is
          the Places omission, and it is deliberate — see the header. This comment
          exists so the next person to open this file does not read the gap as an
          oversight and close it with a geolocation prompt.
        */}

        {attempted && incomplete ? (
          <InlineError message={copy.addressMissingBody} testID="address-missing" />
        ) : null}
        {writeError === 'offline' ? (
          <InlineError message={copy.addressWriteOffline} testID="address-write-offline" />
        ) : null}
        {writeError === 'gone' ? (
          <InlineError message={copy.addressGoneBody} testID="address-write-gone" />
        ) : null}
        {writeError === 'failed' ? (
          <InlineError message={copy.addressWriteFailed} testID="address-write-failed" />
        ) : null}

        <PrimaryButton
          label={copy.addressSaveCta}
          onPress={submit}
          /*
            Disabled ONLY by `busy`, never by an incomplete form. A Save that is
            greyed out for a reason she cannot see is a dead end; tapping it and
            being told which fields are missing is the shape sign-in and signup
            already use.
          */
          disabled={busy}
          testID="address-save"
          style={styles.cta}
        />
      </ScrollView>
    </Sheet>
  );
}

/**
 * Field → copy key. A total record rather than a template string, so a field
 * added to `ADDRESS_FIELDS` without a label fails the typecheck instead of
 * rendering `undefined` — which is what `copy['addr' + field]` would have done.
 */
const LABEL_KEY: Record<
  AddressField,
  | 'addrLabel'
  | 'addrBlock'
  | 'addrStreet'
  | 'addrBuilding'
  | 'addrFloor'
  | 'addrApartment'
  | 'addrArea'
  | 'addrGovernorate'
  | 'addrInstructions'
> = {
  label: 'addrLabel',
  block: 'addrBlock',
  street: 'addrStreet',
  building: 'addrBuilding',
  floor: 'addrFloor',
  apartment: 'addrApartment',
  area: 'addrArea',
  governorate: 'addrGovernorate',
  instructions: 'addrInstructions',
};

const styles = StyleSheet.create({
  title: { color: color.ink },
  body: { marginTop: 4, maxHeight: 460 },
  note: { color: color.textMuted, marginTop: 20, marginHorizontal: 2 },
  cta: { marginTop: 22, marginBottom: 6 },
});
