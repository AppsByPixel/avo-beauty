/**
 * Manual member lookup — design:205-239.
 *
 * "For a dead phone or a camera that won't focus." It is the fallback that
 * keeps a customer able to pay when the primary path fails, which makes it part
 * of the money path rather than a convenience.
 *
 * READ src/api/members.ts FIRST. `GET /members?q=` EXISTS and this screen now
 * parses what it actually sends — a directory row. The previous header here said
 * the endpoint did not exist, which was wrong and was read as authoritative.
 *
 * Two consequences visible in the JSX below:
 *
 *   - the row shows `···· 4408` and no balance, because the server sends
 *     `phoneLast4` and no `balanceFils`. The design's row shows both. The
 *     contract wins; escalated.
 *   - picking a row cannot open the member card yet, because that card renders
 *     her balance and stamps and nothing resolves one member for a staff caller.
 *     See ScannerFlow's `handlePick`.
 *
 * The promise at the bottom of the screen — "Manual lookups are logged with
 * your name" — is a SERVER guarantee, and the endpoint keeps it: an append-only
 * audit row per search, written whether or not anything matched.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError } from '../api/client';
import { lookupMembers, MIN_QUERY_LENGTH, type LookupMember } from '../api/members';
import { copy } from '../copy/en';
import { tierLabel } from '../domain/loyalty';
import { color, display, MIN_TAP_TARGET, radius, tierStyles, ui } from '../theme';
import { LinkButton } from '../components/Buttons';
import { EmptyState, ErrorState, OfflineBanner, SkeletonRows } from '../components/States';

type Search =
  | { state: 'idle' }
  | { state: 'searching' }
  | { state: 'results'; rows: LookupMember[] }
  | { state: 'offline' }
  | { state: 'error'; message: string; reference: string };

const DEBOUNCE_MS = 300;

export function LookupScreen({
  accessToken,
  onBack,
  onPick,
  opening = false,
}: {
  accessToken: string;
  onBack: () => void;
  onPick: (member: LookupMember) => void;
  /**
   * True while `GET /members/{id}` is in flight for a row that was just tapped.
   *
   * The rows stop accepting taps for the duration. Picking a second member while
   * the first is still resolving would leave two envelopes racing for one member
   * card, and the one that renders would be whichever answered last — on the
   * screen where money moves, against whichever customer that turned out to be.
   */
  opening?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Search>({ state: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<AbortController | null>(null);

  const run = useCallback(
    async (q: string) => {
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      setSearch({ state: 'searching' });
      try {
        const rows = await lookupMembers(q, accessToken, controller.signal);
        if (!controller.signal.aborted) setSearch({ state: 'results', rows });
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError) {
          if (err.kind === 'offline') {
            setSearch({ state: 'offline' });
            return;
          }
          setSearch({ state: 'error', message: err.message, reference: err.reference });
          return;
        }
        setSearch({ state: 'error', message: copy.errorBody, reference: '—' });
      }
    },
    [accessToken],
  );

  // Debounced. A search that fires per keystroke is a directory scrape from the
  // server's point of view, and the minimum length is the other half of that.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      inflight.current?.abort();
      setSearch({ state: 'idle' });
      return;
    }
    timer.current = setTimeout(() => void run(q), DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, run]);

  useEffect(() => () => inflight.current?.abort(), []);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <LinkButton label={copy.backToScan} onPress={onBack} testID="lookup-back" />
        <Text style={[ui(12), styles.eyebrow]}>{copy.lookupEyebrow}</Text>
      </View>

      <Text style={display(24)}>{copy.lookupTitle}</Text>
      <Text style={[ui(12.5), styles.sub]}>{copy.lookupSub}</Text>

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={copy.lookupPlaceholder}
        placeholderTextColor={color.textMutedSoft}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={copy.lookupTitle}
        testID="lookup-input"
        style={[ui(15), styles.input]}
      />

      <View style={styles.results}>
        {search.state === 'searching' && <SkeletonRows count={2} />}

        {search.state === 'offline' && <OfflineBanner />}

        {search.state === 'error' && (
          <ErrorState
            body={search.message}
            reference={search.reference}
            onRetry={() => void run(query.trim())}
          />
        )}

        {search.state === 'results' && search.rows.length === 0 && (
          <EmptyState title={copy.lookupNoneTitle} body={copy.lookupNoneBody} />
        )}

        {search.state === 'results' &&
          search.rows.map((m) => {
            const tier = tierStyles[(m.tier ?? 'member') as keyof typeof tierStyles];
            return (
              <Pressable
                key={m.id}
                onPress={() => onPick(m)}
                /*
                  Both halves matter. `disabled` stops the tap; `accessibilityState`
                  is how a VoiceOver user is told the row stopped accepting one,
                  which a visual dim alone does not communicate.
                */
                disabled={opening}
                accessibilityRole="button"
                accessibilityState={{ disabled: opening, busy: opening }}
                accessibilityLabel={`${m.name}, number ending ${m.phoneLast4}`}
                testID={`lookup-${m.id}`}
                style={[styles.row, opening && styles.rowOpening]}
              >
                <View style={styles.rowAvatar}>
                  <Text style={[display(17, '600'), styles.rowInitial]}>
                    {m.name.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.rowText}>
                  <View style={styles.rowNameLine}>
                    <Text style={ui(14.5, '600')}>{m.name}</Text>
                    <View style={[styles.tierPill, { backgroundColor: tier.pillBg }]}>
                      <Text style={[ui(10.5, '600'), { color: tier.pillText }]}>
                        {tierLabel(m.tier) || 'Member'}
                      </Text>
                    </View>
                  </View>
                  {/*
                    THE DESIGN'S ROW SHOWS THE FULL NUMBER AND THE BALANCE
                    (design:222-223, `{{ m.phone }} · {{ m.idStr }}` and
                    `{{ m.bal }}`). The server sends neither, on purpose — see
                    api/members.ts. This is a design-vs-contract conflict and the
                    contract wins the same way it does for the top-up fee lines:
                    not because the design is wrong about what is useful, but
                    because the only way to render it is to invent it, and the
                    invented number here is money.

                    `phoneLast4` is what identifies her at the counter anyway —
                    the artist reads the last four back to her. ESCALATED to
                    trunk rather than settled here.
                  */}
                  <Text style={[ui(12), styles.rowMeta]}>
                    ···· {m.phoneLast4} · {copy.memberId(m.id)}
                  </Text>
                </View>
              </Pressable>
            );
          })}
      </View>

      {/* design:233-236 — the promise the server keeps, stated to the artist. */}
      <View style={styles.notice}>
        <View style={styles.noticeDot} />
        <Text style={[ui(12), styles.noticeText]}>{copy.lookupLogged}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { paddingTop: 66, paddingHorizontal: 22, paddingBottom: 26, flexGrow: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  eyebrow: { color: color.textMutedSoft },
  sub: { color: color.textMuted, marginTop: 5, lineHeight: 19 },
  input: {
    marginTop: 18,
    minHeight: MIN_TAP_TARGET,
    borderWidth: 1,
    borderColor: color.borderControl,
    borderRadius: radius.input,
    paddingVertical: 15,
    paddingHorizontal: 16,
    backgroundColor: color.white,
    color: color.ink,
  },
  results: { gap: 10, marginTop: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: MIN_TAP_TARGET,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    padding: 14,
  },
  rowAvatar: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: color.brandTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowInitial: { color: color.brandDeep },
  /** Opening one row: the list stays readable and stops being actionable. */
  rowOpening: { opacity: 0.55 },
  rowText: { flex: 1, minWidth: 0 },
  rowNameLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  tierPill: { borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9 },
  rowMeta: { color: color.textMuted, marginTop: 2 },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    backgroundColor: color.brandTint2,
    borderWidth: 1,
    borderColor: 'rgba(110,127,108,0.22)',
    borderRadius: radius.chip,
    paddingVertical: 11,
    paddingHorizontal: 14,
    marginTop: 18,
  },
  noticeDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: color.brand, marginTop: 5 },
  noticeText: { color: color.brandDeeper, flex: 1, lineHeight: 18 },
});
