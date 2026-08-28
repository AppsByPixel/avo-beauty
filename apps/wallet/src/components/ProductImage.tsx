/**
 * The product tile — the swatch the design already draws, with a photograph on
 * top of it when there is one and the session can fetch it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SWATCH IS THE FLOOR, NOT THE FALLBACK, AND THAT IS THE WHOLE DESIGN.
 *
 * `image: null` is the COMMON case — the API gained the capability this week and
 * almost no product has a photograph. `design/AVO States.dc.html` is emphatic
 * that a state must look deliberate rather than degraded, and the swatch already
 * is: `domain/cart.ts` § `swatchFor` derives one of the design's own five hexes
 * from the product id, and the letter is the design's letter (design:1424-1428).
 * A product with no photograph does not look like a product whose photograph
 * failed. It looks like the Shop screen always has.
 *
 * So the swatch is painted for EVERY row, always, and the `<Image>` is an overlay
 * that fades in over it. Four of this slice's five states are therefore one piece
 * of code and cannot drift apart:
 *
 *   no image        the overlay never mounts
 *   loading         the overlay is mounted at opacity 0
 *   failed          the overlay stays at opacity 0
 *   offline         a fetch that cannot leave the device — same as failed
 *   ready           the overlay is at opacity 1 and covers the swatch
 *
 * THE OFFLINE RULE FALLS OUT OF THAT RATHER THAN BEING BOLTED ON, which is why
 * it is trustworthy. `interaction-spec.md` §4 wants a network failure to keep the
 * last-known data visible instead of blanking, and the brief for this slice put
 * it sharply: an image that cannot be fetched offline must not turn a usable shop
 * list into a broken-looking one. Here an offline shop list is a list of rows
 * that look exactly like rows for products with no photograph — which is what
 * most of them ARE — above the `OfflineBanner` the screen already shows. There is
 * no second treatment to get wrong, no broken-image glyph, and no spinner left
 * spinning on a device with no connection.
 *
 * AND IT IS WHY THERE IS NO NEW COPY. A decorative overlay over a swatch that
 * already carries the product's letter says nothing a caption could add, and
 * `Product` has no `nameAr` (decision 46) so any string built from a product name
 * would be Latin inside an Arabic screen. The tile is
 * `accessibilityElementsHidden`; the row's name and price are the accessible
 * content, unchanged.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYOUT CANNOT JUMP, BY CONSTRUCTION AND NOT BY MEASUREMENT.
 *
 * The box is the swatch's own fixed size — 52 on Shop, 42 in the cart, straight
 * off the design — and the overlay is `position: absolute` inside it. Nothing in
 * the row reflows when an image arrives, because nothing in the row is sized by
 * the image. `width`/`height` from the payload are not needed to reserve space;
 * they are used for the one thing a fixed square genuinely cannot decide on its
 * own, below.
 *
 * `resizeMode` FROM THE PAYLOAD'S ASPECT RATIO. A square-ish photograph fills the
 * tile (`cover`); an extreme one is letterboxed instead (`contain`), because
 * cropping a 4:1 product shot to a square keeps a quarter of it and that quarter
 * is usually not the bottle. The threshold is deliberately loose — the API's own
 * ceilings allow up to 4096 on the longest side and 12MP, so a panorama is a
 * shape it will accept.
 *
 * There is no `onLayout`, no `Image.getSize`, and no state that depends on the
 * decoded bitmap. Giving `<Image>` an explicit pixel size also lets iOS downsample
 * during decode rather than after — which matters here more than usual, because
 * `routes/images.ts` states plainly that it does no resizing and serves originals:
 * "the wallet downloads the full-size file on a phone."
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { Image, StyleSheet, Text, View } from 'react-native';
import type { ImageRef } from '@avo/types';
import { initialFor, swatchFor } from '../domain/cart';
import { useLanguage } from '../i18n/language';
import { color, text } from '../theme';
import { useAuthedImage } from './authedImage';

/**
 * Past this, `cover` throws away more than half the picture. 2.2 is a hair wider
 * than the widest shape a phone-shot product photo lands on (16:9 is 1.78), so an
 * ordinary landscape photograph still fills the tile.
 */
const LETTERBOX_ABOVE = 2.2;

export function ProductImage({
  productId,
  name,
  image,
  size,
  radius,
  letterSize,
  testID,
}: {
  productId: string;
  name: string;
  image: ImageRef | null;
  /** The design's own square. 52 on Shop (design:495), 42 in the cart. */
  size: number;
  radius: number;
  letterSize: number;
  testID?: string | undefined;
}) {
  const { lang } = useLanguage();
  const { source, ready, onLoad, onError } = useAuthedImage(image);

  const ratio = image === null ? 1 : Math.max(image.width, image.height) / Math.min(image.width, image.height);

  return (
    <View
      style={[styles.box, { width: size, height: size, borderRadius: radius, backgroundColor: swatchFor(productId) }]}
      /*
        Decorative. The row already announces the product's name and its price,
        and a screen reader stopping on a picture of the thing it just named is
        noise. `importantForAccessibility` is the Android half of the same
        statement; RN needs both.
      */
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}
    >
      <Text style={[text('displayS', lang), styles.letter, { fontSize: letterSize }]}>
        {initialFor(name)}
      </Text>

      {source === null ? null : (
        <Image
          source={source}
          onLoad={onLoad}
          onError={onError}
          resizeMode={ratio > LETTERBOX_ABOVE ? 'contain' : 'cover'}
          /*
            `absoluteFill`, so RTL cannot move it: a box pinned on all four edges
            has no start and no end, and `I18nManager.forceRTL` has nothing to
            mirror. An overlay positioned with `left` would sit on the wrong side
            of an Arabic tile (#12).

            OPACITY, NOT CONDITIONAL MOUNTING. Unmounting until `ready` would mean
            the `<Image>` never loads, since nothing would be requesting it; and
            remounting on every failure would retry forever. It is mounted, it is
            invisible, and the swatch shows through until it has something to
            show.
          */
          style={[
            StyleSheet.absoluteFill,
            { borderRadius: radius, opacity: ready ? 1 : 0 },
          ]}
          testID={testID === undefined ? undefined : `${testID}-photo`}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' },
  letter: { color: color.textMutedSoft },
});
