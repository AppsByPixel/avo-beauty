import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { authedRequest } from '../auth/authedRequest.js';

/**
 * The owner console's Controls and Audit sections.
 *
 * ONE CLIENT FILE PER SERVER ROUTE FILE, the same reasoning `platformAdmins.ts`
 * carries: these live together in `api/src/routes/platformConsole.ts` and
 * are gated on DIFFERENT sections, which is the thing a consumer most needs
 * to get right. Checked in the handlers rather than inferred from the names:
 *
 * `GET /v1/platform/metrics` (analytics) is still served there, and no screen
 * reads it any more: the Analytics page moved to `GET /v1/platform/analytics`
 * (`api/platformAnalytics.ts`), so its hook and parser were retired from here.
 *
 *   GET   /v1/platform/settings   controls    platformConsole.ts:121
 *   PATCH /v1/platform/settings   controls    platformConsole.ts:148
 *   GET   /v1/platform/audit      audit       platformConsole.ts:330
 *
 * NO CLIENT COURTESY GATE, for the reason `platformAdmins.ts` sets out: every READ
 * here is gated too, so an admin without the section gets a 403 on load and
 * `SectionError` renders the server's own sentence. A second check on the client
 * would duplicate the server and drift from it. The sidebar marks the item, which
 * is a courtesy and not a control — non-negotiable #7.
 */

export const consoleKeys = {
  settings: ['platform', 'settings'] as const,
};

/* ========================================================== parse helpers == */

/*
 * PARSED RATHER THAN CAST, and this is not ceremony. Every number the console
 * reads here is money or a setting that goes straight onto a screen; a `null`
 * arriving where a fils integer was promised would render "NaN" under a KD unit,
 * and `<Money>` on a non-integer would silently produce a wrong figure.
 * `PATCH /v1/salons/{id}` is the standing lesson in this repo about trusting a
 * response shape — it answered something no consumer could read and took a whole
 * section to its error boundary. (The rationale used to sit on
 * `parsePlatformMetrics`, retired with the old Analytics page.)
 */

function num(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${where} was not a number.`);
  }
  return v;
}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${where} was not an object.`);
  }
  return v as Record<string, unknown>;
}

/* ====================================================== CONTROLS (settings) = */

/** The design's five switch ids, and the server's `PLATFORM_FLAGS`, in its order. */
export const PLATFORM_FLAGS = ['signups', 'booking', 'shop', 'wa', 'maintenance'] as const;
export type PlatformFlag = (typeof PLATFORM_FLAGS)[number];
export type PlatformFlags = Record<PlatformFlag, boolean>;

/**
 * `GET /v1/platform/settings`. The fee fields arrive NESTED under `commission`.
 *
 * THE PATCH DOES NOT ACCEPT THAT SHAPE, and the route comment says it does. It
 * claims the body is "the shape `serialisePlatformSettings` emits, so the console
 * can send back a subset of exactly what it read rather than transposing between
 * two shapes" — but `serialisePlatformSettings` nests the three fees under
 * `commission`, while the PATCH allow-list is
 * `['flags','knetFlatFils','cardPercentBp','cardFlatFils','newSalonDepositFils']`,
 * flat. Driven against the real endpoint on `avo_lane_c`:
 *
 *   PATCH {"commission":{"knetFlatFils":160}}  400 invalid_field
 *                                              "Not editable: commission."
 *   PATCH {"knetFlatFils":160}                 200
 *
 * So a client that followed the comment would be refused on every fee change. The
 * discrepancy is in `api/` and is reported to trunk rather than edited from this
 * lane; `useUpdatePlatformSettings` below sends the FLAT shape the handler really
 * reads, and `UpdateSettingsInput` is typed so the nested form cannot be built by
 * accident.
 */
export interface PlatformSettings {
  flags: PlatformFlags;
  commission: {
    /** Integer fils, flat, per KNET top-up. */
    knetFlatFils: number;
    /** BASIS POINTS. 250 is 2.5%. Integer, and a multiple of 50 — see below. */
    cardPercentBp: number;
    /** Integer fils, added to the percentage on every card/Apple Pay top-up. */
    cardFlatFils: number;
  };
  newSalonDepositFils: number;
  /** The admin who last changed it, or null when nobody has since the migration. */
  updatedBy: string | null;
  updatedAt: string;
}

function parseFlags(v: unknown): PlatformFlags {
  const o = obj(v, 'settings.flags');
  const out = {} as PlatformFlags;
  for (const f of PLATFORM_FLAGS) {
    if (typeof o[f] !== 'boolean') throw new Error(`settings.flags.${f} was not a boolean.`);
    out[f] = o[f] as boolean;
  }
  return out;
}

export function parsePlatformSettings(raw: unknown): PlatformSettings {
  const r = obj(raw, 'GET /v1/platform/settings');
  const c = obj(r.commission, 'settings.commission');
  if (typeof r.updatedAt !== 'string') throw new Error('settings.updatedAt was not a string.');
  if (r.updatedBy !== null && typeof r.updatedBy !== 'string') {
    throw new Error('settings.updatedBy was neither a string nor null.');
  }
  return {
    flags: parseFlags(r.flags),
    commission: {
      knetFlatFils: num(c.knetFlatFils, 'settings.commission.knetFlatFils'),
      cardPercentBp: num(c.cardPercentBp, 'settings.commission.cardPercentBp'),
      cardFlatFils: num(c.cardFlatFils, 'settings.commission.cardFlatFils'),
    },
    newSalonDepositFils: num(r.newSalonDepositFils, 'settings.newSalonDepositFils'),
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt,
  };
}

/**
 * `enabled` EXISTS FOR A SECOND CONSUMER, and it is not a permission check.
 *
 * Controls calls this with no argument and is gated by the section it lives in.
 * The onboarding wizard next door reads ONE field from it — the platform's
 * new-salon deposit default, which `POST /v1/platform/salons` applies when the
 * body omits `depositFils` — and the wizard is reachable by an admin who holds
 * `salons` and NOT `controls` (the `support` preset is exactly that shape). For
 * her this read is a guaranteed 403.
 *
 * So the flag says "do not make a request whose refusal is already known", which
 * is a courtesy about network noise rather than a control: #7 is unaffected, the
 * server still refuses, and the caller falls back to a value it shows on screen.
 * Passing `enabled: false` must never be how a screen decides what someone may
 * see.
 */
export function usePlatformSettings(
  options: { enabled?: boolean } = {},
): UseQueryResult<PlatformSettings> {
  return useQuery({
    queryKey: consoleKeys.settings,
    enabled: options.enabled ?? true,
    queryFn: async ({ signal }) =>
      parsePlatformSettings(
        await authedRequest<unknown>('owner', '/v1/platform/settings', { signal }),
      ),
  });
}

/**
 * The server's bounds, restated so a control cannot offer a value the server will
 * refuse. `api/src/services/platformSettings.ts` is the source; these are read from
 * it rather than chosen here, and the CHECK constraints behind the columns remain
 * the guarantee.
 *
 * `CARD_PERCENT_STEP_BP` IS ARITHMETIC, NOT UI FIDELITY, and it is the one bound on
 * this screen that is a money rule. The endpoint's own reasoning, measured: the
 * server divides these basis points by 100 to get a percent, so a rate off the
 * half-point step "cannot be applied to a fil exactly" — 172,705 of 7,800,000
 * half-fil boundaries came out ONE FIL apart across 136 unsafe rates, and 29 bp on
 * 25.000 KD is 73 fils exact but 72 through the float. The stepper therefore moves
 * in 50 bp and cannot express an unsafe rate at all.
 */
export const KNET_FLAT_MIN_FILS = 0;
export const KNET_FLAT_MAX_FILS = 500;
export const KNET_FLAT_STEP_FILS = 10;
export const CARD_PERCENT_MIN_BP = 0;
export const CARD_PERCENT_MAX_BP = 500;
export const CARD_PERCENT_STEP_BP = 50;
export const CARD_FLAT_MIN_FILS = 0;
export const CARD_FLAT_MAX_FILS = 500;
export const DEPOSIT_MIN_FILS = 1000;
export const DEPOSIT_MAX_FILS = 10_000;
/** The design's deposit stepper is drawn in whole KD. 1000 fils = 1 KD. */
export const DEPOSIT_STEP_FILS = 1000;

/**
 * THE FLAT SHAPE THE HANDLER ACTUALLY READS. `commission` is deliberately not a
 * key here — see the header. Every field is an integer; there is no float on this
 * path, which is non-negotiable #1 on a body that prices every future top-up.
 */
export interface UpdateSettingsInput {
  flags?: Partial<PlatformFlags>;
  knetFlatFils?: number;
  cardPercentBp?: number;
  cardFlatFils?: number;
  newSalonDepositFils?: number;
}

export function useUpdatePlatformSettings(): UseMutationResult<
  PlatformSettings,
  unknown,
  UpdateSettingsInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input) =>
      parsePlatformSettings(
        await authedRequest<unknown>('owner', '/v1/platform/settings', {
          method: 'PATCH',
          body: input,
        }),
      ),
    onSuccess: (settings) => {
      /*
       * Replaced from the RESPONSE, not the request. The handler returns the whole
       * row through the same `serialisePlatformSettings` the GET uses, so caching it
       * is safe — and it is the only way the screen learns `updatedBy`/`updatedAt`,
       * which the server stamps and the client cannot know.
       */
      queryClient.setQueryData<PlatformSettings>(consoleKeys.settings, settings);
    },
  });
}

/* -------------------------------------------------------------- flag copy -- */

/**
 * `AVO Owner Console.dc.html:1558` § flagDefs — label and description verbatim,
 * in the design's order, which is also `PLATFORM_FLAGS`'s order.
 */
export const FLAG_LABEL: Record<PlatformFlag, string> = {
  signups: 'New customer signups',
  booking: 'Booking module',
  shop: 'Shop module',
  wa: 'WhatsApp notifications',
  maintenance: 'Maintenance mode',
};

export const FLAG_DESC: Record<PlatformFlag, string> = {
  signups: 'Allow new wallets to be created across the platform.',
  booking: 'Master switch for service booking everywhere.',
  shop: 'Master switch for in-app product shops.',
  wa: 'Confirmations, reminders and receipts platform-wide.',
  maintenance: 'Show a maintenance screen and pause all charges.',
};
