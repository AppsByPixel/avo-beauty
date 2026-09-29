import { deriveBrandSet, tier } from '@avo/tokens';
import type { Salon } from '@avo/types';
import type { SegmentedOption } from '@avo/ui';
import { TIER_LABEL } from '../api/loyalty.js';

type LoyaltyMode = Salon['loyaltyMode'];

/**
 * ==========================================================================
 * The wallet card: tier colours, or the salon's own colour
 * ==========================================================================
 * Aftab, 2026-09-29: "if … that workspace has a dark green theme chosen then it
 * should override this tier coloring for that workspace." Trunk's fd6edc8 made
 * that a stored choice, `Salon.walletCard: 'tier' | 'brand'` (default `tier`),
 * rather than a rule keyed off the hex — so any theme can keep its colour, and
 * the forest preset is simply the case that asked for it.
 *
 * SHARED BY TWO HOSTS, and nothing here writes. Merchant → Settings owns a
 * `PATCH /salons/{id}`; the console's onboarding wizard carries the choice into
 * `POST /v1/platform/salons`. Each host owns its own request, its own gate and
 * its own refusal; this file is the words and the picture, so the two cannot
 * describe the setting differently.
 *
 * NEW WORK. The design bundle predates the setting and draws no such control.
 * The two labels and their one-line meanings are Aftab's framing from the brief
 * ("silver is silver, gold is gold"; "the workspace's own colour on every
 * card"); they are reported as new strings for a writer.
 */

export type WalletCard = Salon['walletCard'];

export const WALLET_CARD_OPTIONS: SegmentedOption<WalletCard>[] = [
  { value: 'tier', label: 'Tier colours' },
  { value: 'brand', label: 'Our colour' },
];

export const WALLET_CARD_LABEL: Record<WalletCard, string> = {
  tier: 'Tier colours',
  brand: 'Our colour',
};

export const WALLET_CARD_BODY: Record<WalletCard, string> = {
  tier: 'Silver is silver, gold is gold.',
  brand: 'The workspace’s own colour on every card.',
};

/**
 * THE STAMPS CASE, IN WORDS. The wallet paints a stamps salon's card in its
 * brand whatever `walletCard` says — `apps/wallet/src/theme/cardInk.ts`:
 * "stamps mode → the brand card, exactly as it was" — because there is no tier
 * to take a colour from. The choice is still stored (a salon may switch
 * mechanic later), but a preview that showed a metal here would be a promise
 * the phone does not keep.
 */
export const WALLET_CARD_STAMPS_NOTE = 'Your salon uses stamps, so every card shows your colour.';

/** What the phone will actually draw: the choice, except where stamps overrule it. */
export function effectiveWalletCard(choice: WalletCard, loyaltyMode: LoyaltyMode): WalletCard {
  return loyaltyMode === 'stamps' ? 'brand' : choice;
}

/** The two tiers the preview shows, because they are the two the sentence names. */
const EXAMPLES = ['silver', 'gold'] as const;

/**
 * A small picture of the main card, twice — a Silver member and a Gold one —
 * so the difference between the two choices is the difference between two
 * pictures: two metals, or the same brand twice.
 *
 * EVERY COLOUR COMES FROM THE TOKEN FILE. The metals are `tier.<name>.cardFrom
 * → cardTo`, the stops the wallet paints; the brand is `deriveBrandSet(hex)`'s
 * `cardFrom → cardTo`, the stops `useBrandTheme` writes to `--avo-card-*`. The
 * brand is derived here rather than read off the document because the wizard
 * previews a hex that is not the page's brand yet.
 *
 * NO TEXT SITS ON ANY CARD — non-negotiable #9 by construction. The tier names
 * are captions under the cards, in ink on the page. The bars on the card are
 * decoration (`aria-hidden`), so neither white-on-brand nor a contrast pair
 * arises; the figure is named for a screen reader by its caption and label.
 */
export function WalletCardPreview({
  choice,
  brandHex,
  loyaltyMode,
}: {
  choice: WalletCard;
  brandHex: string;
  loyaltyMode: LoyaltyMode;
}) {
  const source = effectiveWalletCard(choice, loyaltyMode);
  const derived = deriveBrandSet(brandHex);
  /*
   * A hex the deriver refuses never reaches a salon (the API validates through
   * the same function), so this branch is the wizard mid-refusal. It falls back
   * to the page's own card stops rather than painting an unviable colour.
   */
  const brand = derived.ok
    ? { from: derived.set.cardFrom, to: derived.set.cardTo }
    : { from: 'var(--avo-card-from)', to: 'var(--avo-card-to)' };

  return (
    <figure
      className="wcard"
      data-source={source}
      aria-label={`Wallet card preview: ${WALLET_CARD_LABEL[source]}`}
    >
      <div className="wcard__row">
        {EXAMPLES.map((name) => {
          const fill = source === 'tier' ? { from: tier[name].cardFrom, to: tier[name].cardTo } : brand;
          return (
            <div className="wcard__item" key={name}>
              <div
                className="wcard__card"
                data-testid="wallet-card-preview-card"
                data-fill={source === 'tier' ? name : 'brand'}
                data-ink={source === 'tier' ? 'dark' : 'light'}
                aria-hidden="true"
                style={{ ['--wcard-from' as string]: fill.from, ['--wcard-to' as string]: fill.to }}
              >
                <span className="wcard__bar" />
                <span className="wcard__bar wcard__bar--short" />
              </div>
              <span className="wcard__label">{TIER_LABEL[name]}</span>
            </div>
          );
        })}
      </div>
      {/* The design's own caption under its brand-kit preview. */}
      <figcaption className="wcard__caption">Customer app</figcaption>
    </figure>
  );
}
