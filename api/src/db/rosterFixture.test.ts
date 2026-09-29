/**
 * THE MOVE RULE `db:demo-roster` APPLIES TO A LIVE ARTIST — db/rosterFixture.ts
 * § MOVING AN ARTIST WHO HAS APPOINTMENTS.
 *
 * A booking keeps the branch it was written with, so moving its artist
 * elsewhere would leave it in a branch nobody performs it at. The script
 * refuses that artist rather than rewrite a booking. These pin the rule
 * without a database; the script's own run against a live-shaped copy is the
 * end-to-end proof.
 */

import { describe, expect, it } from 'vitest';
import { AMARA_ARTIST_BRANCH, ROSTER_WORKSPACES, decideAssignment, week } from './rosterFixture';

const at = (id: string, branchId: string, branchAssumed = false) => ({
  id,
  branchId,
  branchAssumed,
  startsAt: new Date('2026-10-04T07:00:00Z'),
});

describe('decideAssignment', () => {
  it('an artist already at the target is left alone', () => {
    expect(
      decideAssignment({ currentBranchId: 'BR-SAL', targetBranchId: 'BR-SAL', liveBookings: [at('BK-1', 'BR-KWC')] }),
    ).toEqual({ kind: 'unchanged' });
  });

  it('an unassigned artist with no live bookings is assigned', () => {
    expect(decideAssignment({ currentBranchId: null, targetBranchId: 'BR-KWC', liveBookings: [] })).toEqual({
      kind: 'assign',
    });
  });

  it('bookings that are already at the target do not block the move — Rana and Dana on live', () => {
    // An unassigned artist at Amara books at BR-KWC, assumed: "BR-KWC" sorts first.
    expect(
      decideAssignment({
        currentBranchId: null,
        targetBranchId: 'BR-KWC',
        liveBookings: [at('BK-1', 'BR-KWC', true), at('BK-2', 'BR-KWC', true)],
      }),
    ).toEqual({ kind: 'assign' });
  });

  it('an ASSUMED booking at another branch still blocks — it is the branch her booking names', () => {
    const d = decideAssignment({
      currentBranchId: null,
      targetBranchId: 'BR-SAL',
      liveBookings: [at('BK-1', 'BR-KWC', true), at('BK-2', 'BR-SAL')],
    });
    expect(d.kind).toBe('refuse');
    expect(d.kind === 'refuse' && d.stranded.map((b) => b.id)).toEqual(['BK-1']);
  });

  it('an established booking at her current branch blocks a move away from it', () => {
    const d = decideAssignment({
      currentBranchId: 'BR-KWC',
      targetBranchId: 'BR-SAL',
      liveBookings: [at('BK-1', 'BR-KWC')],
    });
    expect(d.kind).toBe('refuse');
  });
});

describe('the layout', () => {
  it('Amara: Rana and Dana at Kuwait City, Hessa and Shaikha at Salmiya', () => {
    expect(AMARA_ARTIST_BRANCH.map((a) => `${a.id}:${a.branchId}`)).toEqual([
      'AR-001:BR-KWC',
      'AR-002:BR-KWC',
      'AR-003:BR-SAL',
      'AR-004:BR-SAL',
    ]);
  });

  it('Forest and Lumière: two artists at each of two branches, every one with open hours', () => {
    for (const ws of ROSTER_WORKSPACES) {
      const perBranch = new Map<string, number>();
      for (const a of ws.artists) perBranch.set(a.branchId, (perBranch.get(a.branchId) ?? 0) + 1);
      expect([...perBranch.values()], ws.salonId).toEqual([2, 2]);
      for (const a of ws.artists) {
        expect(Object.values(a.windows).some((d) => d.open), `${a.id} has no open day`).toBe(true);
        // Sunday open for all, so one date proves every artist's grid.
        expect(a.windows['0']?.open, `${a.id} is closed on Sunday`).toBe(true);
      }
    }
  });

  it('week() keeps Friday and every unnamed day closed', () => {
    const w = week({ sun: [600, 1260] });
    expect(w['0']).toEqual({ open: true, from: '10:00', to: '21:00' });
    expect(w['5']?.open).toBe(false);
  });
});
