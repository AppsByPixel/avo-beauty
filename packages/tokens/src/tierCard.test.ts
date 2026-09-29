import { describe, expect, it } from 'vitest';
import tokens from '../../../design/tokens/avo-tokens.json' with { type: 'json' };
import { contrastRatio } from './contrast.js';

/**
 * The wallet's main card takes the member's tier colour (Aftab, 2026-09-29: "if the
 * tier is silver the color of the wallet main widget is silver, gold to gold").
 * Metallic fills carry dark text; black carries white. Every word on the card sits
 * somewhere on the gradient, so the text has to clear AA against BOTH ends — the
 * lighter `cardFrom` and the darker `cardTo` — not against a midpoint.
 */
const AA = 4.5;
const TIERS = ['bronze', 'silver', 'gold', 'black'] as const;
type TierCard = { cardFrom: string; cardTo: string; cardText: string };

describe('tier card colours', () => {
  it.each(TIERS)('%s: card text clears AA on both ends of its gradient', (t) => {
    const c: TierCard = tokens.tier[t];
    expect(contrastRatio(c.cardText, c.cardFrom)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(c.cardText, c.cardTo)).toBeGreaterThanOrEqual(AA);
  });

  it('only black carries white text — the metals are too light for it', () => {
    for (const t of TIERS) {
      const c: TierCard = tokens.tier[t];
      expect(c.cardText.toUpperCase() === '#FFFFFF').toBe(t === 'black');
    }
  });
});
