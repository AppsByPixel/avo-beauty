/**
 * Manual member lookup — design:205-239.
 *
 * "For a dead phone or a camera that won't focus." It is the fallback that
 * keeps a customer able to pay when the primary path fails, which makes it part
 * of the money path rather than a convenience.
 *
 * READ src/api/members.ts FIRST. The endpoint this screen needs does not exist
 * in either server. The screen is built to the design and wired to the endpoint
 * the design requires; until lane A ships it, the search renders its error
 * state. That is reported, not worked around — see the report and the module
 * doc for the shape that is owed.
 *
 * The promise at the bottom of the screen — "Manual lookups are logged with
 * your name" — is a SERVER guarantee. This client cannot keep it, and the
 * endpoint that will must write the audit row itself.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { fils } from '@avo/types';
import { ApiError } from '../api/client';
import { lookupMembers, MIN_QUERY_LENGTH, type LookupMember } from '../api/members';
import { copy } from '../copy/en';
import { tierLabel } from '../domain/loyalty';
import { color, display, MIN_TAP_TARGET, radius, tierStyles, ui } from '../theme';
import { LinkButton } from '../components/Buttons';
import { figureOf } from '../components/Money';
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
}: {
  accessToken: string;
  onBack: () => void;
  onPick: (member: LookupMember) => void;
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
                accessibilityRole="button"
                accessibilityLabel={`${m.name}, ${m.phone}`}
                testID={`lookup-${m.id}`}
                style={styles.row}
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
                  <Text style={[ui(12), styles.rowMeta]}>
                    {m.phone} · {copy.memberId(m.id)}
                  </Text>
                </View>
                <Text style={display(15, '600')}>{figureOf(fils(m.balanceFils))}</Text>
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
