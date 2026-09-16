/**
 * Membership — design:343-384, the last section on Home.
 *
 * The model, the two variants and the reasoning behind the illustration column
 * all live in `domain/membership.ts`; this file is the rendering. Three things
 * about the rendering are decisions rather than transcription:
 *
 * 1. THE ROW COUNT IS THE SALON'S. `view.rungs` is whatever `salon.tiers`
 *    carries — two for SAL-LUMIERE, four for Amara. Nothing here assumes four.
 *
 * 2. THE LAST DIVIDER IS DROPPED. The design puts `border-bottom` on every row
 *    including the last, which leaves a rule floating above the card's bottom
 *    padding. `ActivityFeed` already settled this the other way with `rowLast`,
 *    and these two cards sit in the same column three sections apart, so they
 *    match each other.
 *
 * 3. THE STAMP COUNT IS NOT SET IN FRAUNCES, though design:364 asks for it.
 *    Fraunces is reserved for money figures in both languages — see
 *    `theme#moneyFigureFace` — and it has no Arabic-Indic glyphs. "4 of 8" is a
 *    COUNT, so Arabic renders it `٤ من ٨`, and setting that in Fraunces would
 *    fall through to a serif fallback for the digits themselves. The bonus
 *    column, which IS money and IS Western in both languages, does use it.
 */

import { StyleSheet, Text, View } from 'react-native';
import type { Member, Salon } from '@avo/types';
import { color, MICRO_LABEL_COLOR, moneyFigureFace, radius, text, WHITE } from '../theme';
import { useLanguage } from '../i18n/language';
import { salonName } from '../domain/names';
import {
  membershipView,
  type MembershipStamps,
  type MembershipTiers,
} from '../domain/membership';

/**
 * Two alphas the design uses here that the token set has no name for:
 * `rgba(28,27,25,0.2)` for the dashed outline of an uncollected stamp
 * (design:1654) and `rgba(28,27,25,0.25)` for a rule's bullet (design:378).
 *
 * `packages/tokens` is trunk-owned, so a lane cannot add them; they are literals
 * with the same standing as `ActivityFeed`'s `emptyBar`. Both are decoration on
 * a white card and neither carries text, so no contrast rule applies. Reported
 * so they can become tokens on trunk.
 */
const STAMP_OUTLINE = 'rgba(28,27,25,0.2)';
const RULE_BULLET = 'rgba(28,27,25,0.25)';

/**
 * Eight across at the reference 402pt width, wrapping for a larger target.
 *
 * The design uses `grid-template-columns:repeat(8,1fr)`, which stretches to the
 * card. A fixed size is used instead because `stampTarget` is per-salon and only
 * a fixed size degrades sanely past eight — a fluid 12-column row of circles at
 * this width would be 20pt dots.
 */
const DOT = 33;

interface Props {
  member: Member;
  salon: Salon;
}

export function MembershipSection({ member, salon }: Props) {
  const { lang, copy } = useLanguage();
  const view = membershipView(member, salon, lang);

  // A salon with neither a ladder nor a stamp target has no membership to show.
  // Unlike the Upcoming card's empty state this is the ABSENCE OF A FEATURE and
  // not a section that failed to load, so it renders nothing — the same
  // treatment `modules.booking` gets on this screen.
  if (!view) return null;

  return (
    <View style={styles.section}>
      <Text style={[text('label', lang), styles.sectionLabel]}>{copy.membersLabel}</Text>
      {view.mode === 'tiers' ? (
        <TierLadder view={view} salon={salon} />
      ) : (
        <StampCard view={view} />
      )}
    </View>
  );
}

function TierLadder({ view, salon }: { view: MembershipTiers; salon: Salon }) {
  const { lang, copy } = useLanguage();
  const last = view.rungs.length - 1;
  return (
    <>
      <View style={styles.card}>
        {view.rungs.map((rung, index) => {
          const name = copy.tierName[rung.name];
          const requirement = copy.tierRequirement(rung.minVisits, rung.bonusPercent);
          const bonus = copy.tierBonusIllustration(rung.base, rung.credited);
          return (
            <View
              key={rung.name}
              style={[styles.rung, index === last && styles.rungLast]}
              testID={`membership-rung-${rung.name}`}
              // One label for the whole rung, so a reader announces a tier
              // rather than four disconnected fragments — ActivityFeed's rule.
              accessibilityLabel={
                rung.current
                  ? `${name}, ${copy.current}, ${requirement}, ${bonus}`
                  : `${name}, ${requirement}, ${bonus}`
              }
            >
              <View style={styles.rungText}>
                <View style={styles.rungHead}>
                  <Text style={[text('displayS', lang), styles.rungName]}>{name}</Text>
                  {rung.current ? (
                    <View style={styles.currentPill} testID="membership-current">
                      <Text style={[text('bodyS', lang, '600'), styles.currentPillText]}>
                        {copy.current}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text style={[text('bodyS', lang), styles.rungReq]}>{requirement}</Text>
              </View>
              <Text style={styles.rungBonus}>{bonus}</Text>
            </View>
          );
        })}
      </View>
      {/*
        design:359. The authority clause names AVO, not the salon — decision 86.
        `salonName` and not `salon.name`: SAL-LUMIERE's `nameAr` is NULL.
      */}
      <Text style={[text('bodyS', lang), styles.fine]}>
        {copy.tierFine(salonName(salon, lang))}
      </Text>
    </>
  );
}

function StampCard({ view }: { view: MembershipStamps }) {
  const { lang, copy } = useLanguage();

  // Both conditionals are "render what exists": rule 2 describes buying in a
  // shop the salon may not run, and rules 3 and the goal line both NAME the
  // reward, so a salon that has configured none cannot show them at all.
  const rules = [
    copy.stampRule1,
    ...(view.shopCounts ? [copy.stampRule2] : []),
    ...(view.reward ? [copy.stampRule3(view.reward)] : []),
  ];
  const lastRule = rules.length - 1;

  return (
    <View style={styles.stampCard}>
      <View style={styles.stampHead}>
        <Text style={[text('displayS', lang), styles.stampTitle]}>{copy.stampCardTitle}</Text>
        <Text style={[text('bodyL', lang, '600'), styles.stampCount]}>
          {copy.stampCountOf(view.have, view.target)}
        </Text>
      </View>

      <View
        style={styles.dots}
        accessibilityLabel={copy.stampCountOf(view.have, view.target)}
        testID="membership-stamp-dots"
      >
        {Array.from({ length: view.target }, (_, i) => i < view.have).map((filled, i) => (
          <View
            key={i}
            style={[styles.dot, filled ? styles.dotFilled : styles.dotEmpty]}
            // The count is announced once, on the container above.
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {filled ? <View style={styles.tick} /> : null}
          </View>
        ))}
      </View>

      {view.reward ? (
        <View style={styles.goal} testID="membership-goal">
          <View style={styles.goalDot} />
          <Text style={[text('bodyS', lang), styles.goalText]}>
            {copy.stampsGoal(view.remaining, view.reward)}
          </Text>
        </View>
      ) : null}

      <View style={styles.rules}>
        {rules.map((rule, index) => (
          <View key={rule} style={[styles.rule, index === lastRule && styles.ruleLast]}>
            <View style={styles.ruleBullet} />
            <Text style={[text('body', lang), styles.ruleText]}>{rule}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // design:344 — 24, the same step ACTIVITY takes.
  section: { marginTop: 24 },
  sectionLabel: { color: MICRO_LABEL_COLOR, marginHorizontal: 4, marginBottom: 10 },

  // ------------------------------------------------------------------ tiers --
  card: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    paddingHorizontal: 16,
  },
  rung: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: color.hairlineInner,
  },
  rungLast: { borderBottomWidth: 0 },
  rungText: { flex: 1, minWidth: 0 },
  // `row` is logical on both targets, so the name and its pill mirror in Arabic
  // without a conditional. See i18n/rtl.ts.
  rungHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rungName: { color: color.ink, fontSize: 16 },
  rungReq: { color: color.textMuted, marginTop: 2 },
  currentPill: {
    backgroundColor: color.brandTint,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  // Brand text on a light surface is brandDeep, never brand. Non-negotiable #9.
  currentPillText: { color: color.brandDeep, fontSize: 10.5 },
  rungBonus: {
    fontFamily: moneyFigureFace('400'),
    fontSize: 13.5,
    letterSpacing: 0.01,
    color: color.textMutedStrong,
  },
  fine: {
    marginTop: 9,
    marginHorizontal: 6,
    color: color.textMutedSoft,
    fontSize: 11.5,
    lineHeight: 18,
  },

  // ----------------------------------------------------------------- stamps --
  stampCard: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 6,
  },
  stampHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  stampTitle: { color: color.ink, fontSize: 18, flexShrink: 1 },
  stampCount: { color: color.brandDeep },
  dots: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // `brand` as a FILL is exactly what non-negotiable #9 reserves it for, and the
  // check on top of it is white.
  dotFilled: { backgroundColor: color.brand },
  /*
    The check inside a collected stamp, drawn with two borders on a rotated box
    rather than the design's 14x14 SVG path.

    NOT a style preference. `vitest.config.ts` records that anything importing
    `react-native-svg` cannot be rendered in this workspace — the chain reaches
    untranspiled Flow in React Native's own source — so an SVG here would have
    cost this section its render test, which is the only thing standing between
    the corrected fine print and a silent regression to the design's wording.
    Two borders and a 45 degree rotation are the same mark with no dependency.
  */
  tick: {
    width: 10,
    height: 5.5,
    marginTop: -2.5,
    borderLeftWidth: 2.2,
    borderBottomWidth: 2.2,
    borderColor: WHITE,
    transform: [{ rotate: '-45deg' }],
  },
  dotEmpty: { borderWidth: 1.5, borderColor: STAMP_OUTLINE, borderStyle: 'dashed' },
  goal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: color.brandTint,
    borderRadius: radius.input,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 16,
  },
  goalDot: { width: 7, height: 7, borderRadius: radius.pill, backgroundColor: color.brand },
  goalText: { color: color.brandDeeper, flex: 1, lineHeight: 18 },
  rules: { marginTop: 6 },
  rule: {
    flexDirection: 'row',
    gap: 11,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: color.hairlineInner,
  },
  ruleLast: { borderBottomWidth: 0 },
  ruleBullet: {
    width: 5,
    height: 5,
    borderRadius: radius.pill,
    backgroundColor: RULE_BULLET,
    marginTop: 7,
  },
  ruleText: { color: color.textMutedLabel, flex: 1, lineHeight: 19 },
});
