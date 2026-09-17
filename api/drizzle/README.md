# `api/drizzle/` — the migrations, and the one way two lanes break them

Everything about *how* the service behaves lives next to the code it describes. This
file is here because the thing that breaks this directory is not in any of its files:
it is `meta/_journal.json`, a shared index that two lanes edit on the same line.

`api/README.md` is the map of the **test surfaces** and says so in its opening
sentence. This is not one, which is why it is here and not there.

---

## Two lanes each write "the next migration", and both write `0051`

The conflict does not look like one. It surfaces as a single line in
`meta/_journal.json`, a merge resolves it "cleanly" by taking either side, and **both
sides are wrong**: one drops a migration from the journal, the other leaves two entries
claiming the same `idx`. Neither fails to merge. Nothing is red. A `pnpm db:migrate` or
a `git bisect` weeks later then runs a journal that disagrees with the directory, and by
then nobody connects it to a merge.

That asymmetry is the whole reason this is written down. A busy-machine gate failure is
loud — eight hours and 27 reds gets investigated. This one is silent and merges cleanly.

Measured 2026-09-17: lane A's `0051_the_no_show_window_has_a_ceiling` and a peer
session's own `0051` collided exactly this way.

**`LANES.md` § "Two lanes holding a migration have a merge-order dependency on each
other" carries the cross-lane half** — when to expect it, and who renumbers. Read that
one if you are dispatching or merging. This file carries the mechanics, for the lane
that is about to type `00NN_`.

## Before you add one

```bash
ls api/drizzle/*.sql | tail -3
```

and say in your lane report that you are holding a migration. If another lane also is,
whoever lands second renumbers.

## Renumbering is not `git mv`

Everything that names the file moves with it:

- the migration's own header comment, including cross-references to other numbers
- source that cites it — `services/ids.ts`, `routes/orders.ts`, `routes/auth.ts`
- specs that assert against it, e.g. `mintedIds.int.test.ts`'s `FLOOR` block
- `meta/_journal.json` — the `idx`, the `tag`, and the `when`
- **the commit messages**, which is the one everybody forgets

**If your lane holds more than one migration, rewrite the intermediate commits**
(`git cherry-pick` + `git commit --amend`) rather than renumbering in a commit on top.
A commit carrying a duplicate `idx` is a broken bisect point *even when the branch tip
is correct* — and a bisect is exactly when somebody is already confused.

## Verify with an assertion, never by eye

Four properties: no duplicate `tag`, no duplicate `idx`, no journal entry without a
file, no file without an entry.

```bash
python3 -c "
import json, os
j = json.load(open('api/drizzle/meta/_journal.json'))
tags = [e['tag'] for e in j['entries']]
idxs = [e['idx'] for e in j['entries']]
print('entries:', len(tags))
print('dup tag:', len(tags) != len(set(tags)))
print('dup idx:', len(idxs) != len(set(idxs)))
print('entry w/o file:', [t for t in tags if not os.path.exists('api/drizzle/%s.sql' % t)])
print('file w/o entry:', [f[:-4] for f in sorted(os.listdir('api/drizzle'))
                          if f.endswith('.sql') and f[:-4] not in tags])
"
```

A clean tree prints four falsy answers and a count:

```
entries: 55
dup tag: False
dup idx: False
entry w/o file: []
file w/o entry: []
```

Run it after any rebase that touched this directory, not just after a conflict — the
failure mode is precisely that there was no conflict to notice.
