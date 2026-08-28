import { useId, useRef, useState } from 'react';

/**
 * A square, fillable picture slot — drop a file on it or click to browse.
 *
 * ============================================================================
 * WHERE THIS SHAPE COMES FROM, BECAUSE THE DESIGN BUNDLE HAS NO PRODUCT IMAGE UI
 * ============================================================================
 * `design/AVO Merchant Dashboard.dc.html` draws exactly one image affordance and
 * it is not this one: the salon logo in Settings → Brand kit (line 972), a 52px
 * `<image-slot shape="rounded" radius="14" placeholder="Logo">` with the caption
 * "Drop a square SVG or PNG, at least 1024px." There is no Shop image, no product
 * thumbnail and no gallery anywhere in the bundle.
 *
 * CLAUDE.md says the designs are final and forbids restyling, so the choice was
 * between inventing a second visual language for "put a picture here" and
 * borrowing the one the bundle already establishes for exactly that act. This
 * borrows it: a square, a rounded corner at the drawn radius, a short placeholder
 * word, drop-or-click, and a caption stating the constraint. Same vocabulary, one
 * screen over — which is also what makes it a `packages/ui` component rather than
 * a Shop-local one, since Brand kit is the other caller waiting for it.
 *
 * TWO DEPARTURES FROM THE DRAWN SLOT, BOTH FORCED AND BOTH NAMED:
 *
 *   THE CAPTION IS NOT PER-SLOT. Brand kit has one slot and can afford a
 *   two-line caption beside it. A catalog has one slot PER ROW and forty copies
 *   of "PNG, JPEG or WebP" is noise, so the constraint is stated once at the head
 *   of the screen and the slot carries it in its accessible name. `caption` is
 *   still here for the single-slot caller.
 *
 *   SVG IS REFUSED, AND THE DRAWN CAPTION OFFERS IT. "Drop a square SVG or PNG"
 *   is the brand-kit caption; `api/src/images/inspect.ts` refuses SVG outright
 *   because it is executable. So this component never advertises SVG and its
 *   `accept` names the three types the API takes. The drawn caption is a conflict
 *   between the design bundle and the API for the Brand kit slice to resolve when
 *   it lands — flagged, not silently corrected on a screen it does not appear on.
 *
 * ============================================================================
 * IT OWNS NO BYTES AND NO OBJECT URLS
 * ============================================================================
 * `src` is whatever the caller resolved — for an authenticated read that is an
 * object URL the caller created and will revoke. This component must not create
 * one, because the thing that can revoke it is the thing that knows when the
 * image stops being needed, and that is never the leaf.
 */

export type ImageSlotState =
  /** Nothing here yet. The common case in a catalog, and it is not a failure. */
  | 'empty'
  /** Bytes on the way in from the server. */
  | 'loading'
  /** `src` is paintable. */
  | 'ready'
  /** Bytes on the way OUT — `src` is a local preview of what she picked. */
  | 'uploading'
  /** Nothing paintable, and a reason the caller is rendering elsewhere. */
  | 'error';

export interface ImageSlotProps {
  state: ImageSlotState;
  /** Object URL or absolute src. Required for `ready` and `uploading`. */
  src?: string | null | undefined;
  /** Describes the picture, never the control. Empty when it is decorative. */
  alt?: string | undefined;
  /** The accessible name of the button — say what it is a picture OF. */
  label: string;
  /** The drawn word inside an empty slot. The design's is "Logo". */
  placeholder?: string | undefined;
  /** The constraint, for a caller with room for it. */
  caption?: string | undefined;
  /** Edge length in px. The design's brand-kit slot is 52. */
  size?: number | undefined;
  /** Corner radius in px. The design's is 14. */
  radius?: number | undefined;
  disabled?: boolean | undefined;
  /** Absent means the picture cannot be taken off — no ✕ is drawn. */
  onRemove?: (() => void) | undefined;
  removeLabel?: string | undefined;
  onPick: (file: File) => void;
  /** The chosen bytes would not paint. Distinct from a transfer that failed. */
  onImageError?: (() => void) | undefined;
}

/**
 * The three the API stores. `api/src/images/inspect.ts` § ACCEPTED_IMAGE_TYPES.
 *
 * A COURTESY, NOT A CONTROL — non-negotiable #7's sentence, and it is literally
 * true here: `accept` filters the file dialog and does NOTHING to a drop. A
 * merchant dragging a logo straight off her desktop is the likeliest first
 * failure on this screen and she reaches the server's 415 either way. That is the
 * right outcome: the server's refusal names SVG and says why, which is a better
 * sentence than a silent local reject that looks like a broken drop target.
 */
const ACCEPT = 'image/png,image/jpeg,image/webp';

export function ImageSlot({
  state,
  src = null,
  alt = '',
  label,
  placeholder = 'Photo',
  caption,
  size = 52,
  radius = 14,
  disabled = false,
  onRemove,
  removeLabel = 'Remove photo',
  onPick,
  onImageError,
}: ImageSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const captionId = useId();

  const busy = state === 'uploading' || state === 'loading';
  const painted = (state === 'ready' || state === 'uploading') && src !== null;

  function take(file: File | undefined | null) {
    if (!file || disabled) return;
    onPick(file);
  }

  return (
    <div className="avo-slot-wrap">
      <div
        className="avo-slot"
        data-state={state}
        data-dragging={dragging || undefined}
        style={{ width: `${size}px`, height: `${size}px`, borderRadius: `${radius}px` }}
        /*
         * THE DROP TARGET IS THE WRAPPER, NOT THE BUTTON. A drop landing on the
         * ✕ that sits on top of a filled slot would otherwise do nothing at all,
         * which reads as a slot that rejects files at random.
         */
        onDragOver={(event) => {
          if (disabled) return;
          // Without this the browser navigates to the file. Both handlers, both
          // required — `dragOver` is the one that actually enables the drop.
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          take(event.dataTransfer?.files?.[0]);
        }}
      >
        <button
          type="button"
          className="avo-slot__hit"
          style={{ borderRadius: `${radius}px` }}
          disabled={disabled || busy}
          aria-label={label}
          aria-describedby={caption ? captionId : undefined}
          aria-busy={busy || undefined}
          onClick={() => inputRef.current?.click()}
        >
          {painted ? (
            <img
              className="avo-slot__img"
              src={src ?? undefined}
              alt={alt}
              style={{ borderRadius: `${radius}px` }}
              onError={onImageError}
              draggable={false}
            />
          ) : null}

          {state === 'loading' ? <span className="avo-slot__shimmer avo-skeleton" aria-hidden="true" /> : null}

          {state === 'empty' ? (
            <span className="avo-slot__placeholder" aria-hidden="true">
              {placeholder}
            </span>
          ) : null}

          {/*
            A BROKEN PICTURE IS DRAWN AS A MARK, NOT AS AN EMPTY SQUARE. An error
            rendered as `empty` would tell a merchant her product has no photo
            when it has one that will not load — she would upload it again to fix
            a problem that is not hers. The sentence lives in the caller; this is
            the thing that makes her look for it.
          */}
          {state === 'error' ? (
            <span className="avo-slot__broken" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                <rect
                  x="2.6"
                  y="4.2"
                  width="14.8"
                  height="11.6"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path d="M3 13l3.6-3.4 3 2.6" stroke="currentColor" strokeWidth="1.5" />
                <path d="M6.5 17.5L14 2.5" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </span>
          ) : null}

          {/*
            WHAT SHOWS WHILE THE BYTES GO UP. A 3 MB photo on salon wifi is not
            instant, and `fetch` reports no upload progress — so this is a
            determinate-looking bar the code cannot honestly fill. It is a
            barber-pole over her own picture instead: the preview says WHICH file
            is going, the motion says it has not finished, and neither claims a
            percentage nobody measured.
          */}
          {state === 'uploading' ? (
            <span className="avo-slot__busy" aria-hidden="true">
              <span className="avo-slot__busy-bar" />
            </span>
          ) : null}
        </button>

        {onRemove && state === 'ready' ? (
          <button
            type="button"
            className="avo-slot__remove"
            aria-label={removeLabel}
            title={removeLabel}
            disabled={disabled}
            onClick={onRemove}
          >
            <span aria-hidden="true">✕</span>
          </button>
        ) : null}

        <input
          ref={inputRef}
          type="file"
          className="avo-slot__input"
          accept={ACCEPT}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            take(event.target.files?.[0]);
            /*
             * Cleared so that picking THE SAME FILE AGAIN fires another change.
             * Without it a merchant who fixes a rejected file in place, keeps the
             * name, and picks it again gets no event at all and a slot that looks
             * broken.
             */
            event.target.value = '';
          }}
        />
      </div>

      {caption ? (
        <span className="avo-slot__caption" id={captionId}>
          {caption}
        </span>
      ) : null}
    </div>
  );
}
