/**
 * The two things both `authedImage` implementations need, in the one file that
 * has no platform variant.
 *
 * It exists so that the shape a component programs against is written down ONCE.
 * Two files exporting a structurally identical `AuthedImage` is how the two
 * halves of a platform split drift: web grows a field, native does not, and the
 * screen compiles against whichever one the type-checker happened to resolve.
 */

/**
 * What a tile needs to know, and deliberately no more.
 *
 * `ready` and `failed` are NOT a two-value enum with a spare state. They start
 * false together and that pair means "still trying", which is the state the Shop
 * list spends most of its life in and the one that must not look like an error.
 * `ProductImage` paints the swatch for every combination except `ready`, so a
 * tile that is loading, a tile that failed, a tile that is offline and a product
 * with no photograph at all render the SAME thing — see that file's header for
 * why that is the design and not a shortcut.
 */
export interface AuthedImage {
  /**
   * Hand straight to `<Image source={…}>`. Null means there is nothing to try:
   * no image on the row, no session to authorise with, or (on web) the bytes
   * have not arrived yet.
   */
  source: { uri: string; headers?: { [key: string]: string } } | null;
  /** The image has painted. The only state in which the swatch is covered. */
  ready: boolean;
  /** It was tried and it will not arrive. Distinct from "not tried yet". */
  failed: boolean;
  onLoad: () => void;
  onError: (event: unknown) => void;
}

/**
 * The HTTP status inside a React Native image error event, or null.
 *
 * NARROWING, NOT CASTING, and the header of `authedImage.native.ts` carries the
 * argument: `responseCode` is emitted by the iOS native code on both
 * architectures and declared by NEITHER the Flow nor the TypeScript definition
 * of the event. A cast would compile today and go on compiling on the day RN
 * renames it, with the 401 retry silently dead and every expired tile blank —
 * which is precisely the class of failure this slice exists to avoid.
 *
 * Written to survive the shape being wrong rather than to assert it is right:
 * every step is checked, and an event that does not carry a number answers null,
 * which the caller treats as "failed, do not retry".
 */
export function httpStatusOfImageError(event: unknown): number | null {
  if (typeof event !== 'object' || event === null) return null;
  const native = (event as { nativeEvent?: unknown }).nativeEvent;
  if (typeof native !== 'object' || native === null) return null;
  const code = (native as { responseCode?: unknown }).responseCode;
  return typeof code === 'number' ? code : null;
}
