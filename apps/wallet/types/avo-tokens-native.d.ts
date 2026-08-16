/**
 * `@avo/tokens/native` is emitted by the token generator as plain JS
 * (packages/tokens/dist/native.js) with no accompanying .d.ts, so TypeScript
 * cannot see it. This declaration describes the shape the generator emits.
 *
 * SHARED-PACKAGE GAP (reported, not fixed — packages/tokens is trunk-owned):
 * `packages/tokens/src/generate.ts` should also emit `dist/native.d.ts`, and
 * `package.json#exports["./native"]` should carry a `types` condition. Until it
 * does, every native consumer (this app and the scanner) has to hand-maintain a
 * copy of this file, which is exactly the drift the generator exists to prevent.
 *
 * Nothing here invents a value — it only names the shape. All actual colours,
 * sizes and weights still come from the generated module at runtime.
 */
declare module '@avo/tokens/native' {
  export interface NativeTextStyle {
    fontSize: number;
    fontWeight: string;
    fontFamily: string;
    lineHeight?: number;
    letterSpacing?: number;
    textTransform?: 'uppercase';
  }

  export interface NativeTheme {
    color: {
      ink: string;
      canvas: string;
      surface: string;
      surfaceAlt: string;
      surfaceAlt2: string;
      brand: string;
      brandDeep: string;
      brandDeeper: string;
      brandTint: string;
      brandTint2: string;
      hairline: string;
      hairlineInner: string;
      textMuted: string;
      textMutedSoft: string;
      textMutedStrong: string;
      success: string;
      positive: string;
      dangerDot: string;
      dangerText: string;
      dangerBg: string;
      warnText: string;
      warnBg: string;
      toggleOff: string;
      disabledBg: string;
      whatsappOnGreen: string;
    };
    card: { from: string; to: string };
    text: Record<
      | 'displayXL'
      | 'displayL'
      | 'displayM'
      | 'displayS'
      | 'money'
      | 'bodyL'
      | 'body'
      | 'bodyS'
      | 'label',
      NativeTextStyle
    >;
    radius: Record<
      'chip' | 'input' | 'button' | 'card' | 'cardLg' | 'walletCard' | 'sheet' | 'pill',
      number
    >;
    space: Record<'cardPadding' | 'gridGap' | 'sectionGap', number>;
    control: { toggleTrack: [number, number]; toggleKnob: number; minTapTarget: number };
    tier: Record<
      'bronze' | 'silver' | 'gold' | 'black' | 'member',
      { dot: string; pillBg: string; pillText: string }
    >;
  }

  export const theme: NativeTheme;
  export default theme;
}
