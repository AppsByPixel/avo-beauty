/**
 * Device enrolment — NOT A DESIGNED SCREEN.
 *
 * Read src/state/device.ts first: it explains why this exists at all. In short,
 * `POST /staff/session` needs `{ salonId, deviceId, handle, pin }` and the
 * designed PIN screen carries only the PIN, because the other three are
 * properties of the phone rather than of the sign-in. This binds them once.
 *
 * IT IS DELIBERATELY PLAIN. There is no design for it, so inventing a styled
 * screen would be inventing product. It uses the app's tokens and nothing else.
 *
 * SINCE THE PAIRING RULING (DECISIONS.md § "Staff phone pairing, phone sign-in,
 * and a truthful receipt line — Aftab, 2026-11-10") a phone is set up by
 * redeeming a pairing code (SetupScreen → ChoosePinScreen), and this form is
 * reachable only from the muted "Set up manually" link on the setup screen, for
 * the seeded pilot. Its pre-filled defaults apply under `__DEV__` only
 * (state/enrolDefaults.ts). The `onBack` link is the way out of a mistaken tap.
 */

import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { copy } from '../copy/en';
import { ENROL_DEFAULTS, writeDeviceBinding, type DeviceBinding } from '../state/device';
import { color, display, radius, ui } from '../theme';
import { LinkButton, PrimaryButton } from '../components/Buttons';

export function EnrolScreen({
  initial,
  onDone,
  onBack,
}: {
  initial: DeviceBinding | null;
  onDone: (binding: DeviceBinding) => void;
  /** Back to the setup screen's two ways in. */
  onBack: () => void;
}) {
  const start = initial ?? ENROL_DEFAULTS;
  const [salonId, setSalonId] = useState(start.salonId);
  const [handle, setHandle] = useState(start.handle);
  const [deviceId, setDeviceId] = useState(start.deviceId);
  const [saving, setSaving] = useState(false);

  const ready = salonId.trim() !== '' && handle.trim() !== '' && deviceId.trim() !== '';

  async function save() {
    if (!ready || saving) return;
    setSaving(true);
    const binding: DeviceBinding = {
      salonId: salonId.trim(),
      // The API lowercases the handle before looking it up
      // (api/src/routes/auth.ts § staffPinSession), so normalise here too and
      // avoid a refusal that looks like a wrong PIN.
      handle: handle.trim().toLowerCase(),
      deviceId: deviceId.trim(),
    };
    await writeDeviceBinding(binding);
    setSaving(false);
    onDone(binding);
  }

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <LinkButton label={copy.setupBack} onPress={onBack} muted testID="enrol-back" />
      </View>
      <Text style={display(24)}>{copy.enrolTitle}</Text>
      <Text style={[ui(12.5), styles.body]}>{copy.enrolBody}</Text>

      <Field label={copy.enrolSalon} value={salonId} onChange={setSalonId} testID="enrol-salon" />
      <Field
        label={copy.enrolHandle}
        value={handle}
        onChange={setHandle}
        autoCapitalize="none"
        testID="enrol-handle"
      />
      <Field
        label={copy.enrolDevice}
        value={deviceId}
        onChange={setDeviceId}
        autoCapitalize="none"
        testID="enrol-device"
      />

      <PrimaryButton
        label={copy.enrolSave}
        onPress={() => void save()}
        disabled={!ready || saving}
        style={styles.action}
        testID="enrol-save"
      />
    </ScrollView>
  );
}

function Field({
  label,
  value,
  onChange,
  autoCapitalize,
  testID,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoCapitalize?: 'none' | 'sentences';
  testID?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={[ui(11, '600'), styles.label]}>{label.toUpperCase()}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        autoCapitalize={autoCapitalize ?? 'sentences'}
        autoCorrect={false}
        accessibilityLabel={label}
        testID={testID}
        style={[ui(15), styles.input]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // 54 where it was 74: the back link now sits above the title.
  screen: {
    flexGrow: 1,
    backgroundColor: color.surface,
    paddingTop: 54,
    paddingHorizontal: 26,
    paddingBottom: 40,
  },
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 20, marginBottom: 20 },
  body: { color: color.textMuted, marginTop: 6, lineHeight: 19 },
  field: { marginTop: 20 },
  label: { color: color.textMutedLabel, letterSpacing: 0.9, marginBottom: 7 },
  input: {
    borderWidth: 1,
    borderColor: color.borderControl,
    borderRadius: radius.input,
    backgroundColor: color.white,
    paddingHorizontal: 16,
    paddingVertical: 15,
    color: color.ink,
  },
  action: { marginTop: 30 },
});
