# Feed motion engine — one mover for the feed

Status: **approved 2026-10-18; implemented, steps 0–6 (see §11 for where
the build departs from this plan).** Written
2026-10-18 from the code at `6203fa7`. Line numbers refer to that commit.

Contracts agreed with the sibling sessions working in `App.tsx` at the same
time (they override the sketches below where the two differ):

- `FeedMotion.run(intent, ids, commit, options?)` keeps its `ids` argument and
  still returns `departed`. Pin/unpin focus hand-off reads it.
- `withViewTransition(update)` stays exported from `src/lib/viewTransition.ts`
  under that name. It is the morph API for composer → card, lightbox tile ↔
  photo, and the splash → login brand mark. Step 6 therefore slims the module
  instead of renaming it to `morph.ts`.
- `data-vt` keeps its name for now. Renaming it would touch regions other
  sessions are editing.

The decision this plan asks for: let `src/lib/feedMotion.ts` become the only
thing that moves `.memo-slot` nodes and the chrome around them. View
Transitions would stay for two snapshot morphs only: the composer's text
becoming the new card, and a lightbox tile growing into the photo. The work
ships in seven steps (0–6). Steps 1–4 are useful even if the owner stops
there.

---

## 1. Why

Today three mechanisms move the same `.memo-slot` nodes:

| Mover | Where | Moves |
| --- | --- | --- |
| (a) CSS slot entrance `rise-in` | `MemoSlot` (`App.tsx:390-432`), `.memo-slot { animation: rise-in }` (`app.css:3037`); suppressed by `enterSuppressRef` (`App.tsx:2173`, `2192-2199`, `3268`, `3287`) and read through `getEntering` (`App.tsx:4116`, `FeedItem` `583-600`) | organic mounts: first load, paging, typed search, remote arrivals |
| (b) View Transitions | `src/lib/viewTransition.ts` (372 lines), CSS section `app.css:5294-5456` + reduce block `5896-5907` | lens swaps, sends, select mode, pill arming, batch actions, tag removal |
| (c) FLIP | `src/lib/feedMotion.ts` (543 lines) | in-place changes: pin, trash, restore, purge, edit, task, remote |

(b) and (c) must know about each other. FLIP defers to the snapshot
(`transitionUpdating`, `feedMotion.ts:514`). It settles whenever a capture
freezes the frame (`onTransitionUpdate`, `attach`). It reads the snapshot's
painted offsets (`paintedTransitionOffsets`) and ends a live transition
before it moves anything (`skipLiveTransition`, `feedMotion.ts:502`). The
View Transition side carries machinery that exists only because snapshots are
not live DOM:

- **The press relay** (`viewTransition.ts:124-239`, ~115 lines). Captured
  elements are not hit-testable, so a press is caught, the transition is
  skipped, and the press is replayed with pointer capture plus a hand-made
  mousedown focus (commits `acb72fa`, `4a06229`).
- **`readPaintedOffsets`**. It seeks each pseudo-element's group animation to
  its end and back to learn where a card is drawn.
- **`poseAtPaintedFrame`**. Before a second capture, cards are posed where
  the cut transition painted them. Even so, the 2026-10-13 probe measured a
  58–73px restart, and the cut transition ran 90ms instead of ~336ms.
- **`tuneFeedTransitionNames`**. A 32-name budget plus near/far stripping
  that must also restore names. React never rewrites a style it believes is
  unchanged, so `data-vt` mirrors the name.
- **Stacking workarounds** for snapshot groups painting over the sticky bar
  (`9d22b6a`, the `topbar` group) and over the composer (`9a9d4f2`).

The house rule "reduced motion = dissolve" is broken between the two systems.
Under reduced motion, (b) re-captures the root (`app.css:5902`) and
cross-fades, so presses are lost for ~150ms. (c) hard-cuts instead:
`canAnimate()` is false (`feedMotion.ts:158`). So a trash under reduced
motion cuts, while a tag pick dissolves.

Five recent fixes (`acb72fa`, `4a06229`, `9d22b6a`, `9a9d4f2`, `77b4c4b`) all
deal with these two systems acting on the same nodes. The aim is to make that
class of bug impossible rather than fix the sixth instance.

## 2. Target design

### 2.1 One run per change

```ts
export type FeedIntent =
  | "lens" | "create" | "pin" | "unpin" | "trash" | "restore" | "purge"
  | "edit-save" | "task" | "remote"
  | "retag"   // new: tag removal / bulk tag — cards change text in place
  | "select"; // new: chrome-only scene changes (select mode, arming pills)

interface RunOptions {
  motion?: "auto" | "none"; // "none": commit only (UA-animated Back, drawer open)
  morphed?: string | null;  // create: the memo whose arrival a morph plays
}

// ids: the memos the action names (targets)
run(intent: FeedIntent, ids: Iterable<string>, commit: () => void, options?: RunOptions): FeedMotionResult
settle(): void            // land everything (logout, unmount)
```

`commit` is the caller's `flushSync(apply)`. **The scroll reset or restore
happens inside it.** For lenses that means today's `swapFeed` `update`: the
flush, the layout effects (query-scroll, place restore, nav recorder, title),
then `if (rewind) scrollTo(0, 0)`. The engine only measures after `commit`
returns, so it always sees the final scroll and layout.

`run` does this, all in one task with no paint in between:

1. **Capture the painted frame.** It covers slots from one viewport above the
   screen to one viewport below it, found by binary search (`firstFrom`) and
   stopping past the band. It also covers the chrome keys (§4).
   `getBoundingClientRect()` already includes a running glide's `translate`
   and an arrival's `transform`. Computed `opacity` gives a fade in flight.
   `getAnimations()` tells the engine's own animations apart from CSS ones.
   The layout box is the rect minus those, as `measure()` already does
   (`feedMotion.ts:190`).
2. **Clone what will change in place.** Clone only targets whose content
   changes (edit-save, pin/unpin copies, retag) and topbar chrome keys (small
   nodes). Departing slots need no clone: React hands back the detached node,
   which `ghost()` already uses.
3. **`commit()`.** Then `observer.takeRecords()` claims this commit's mounts
   (§2.4).
4. **Settle layout before measuring.** Force the post-commit band to
   `content-visibility: visible` until two frames later (§6.2). Under reduced
   motion, also finish the column's layout transitions (composer fold,
   search-summary fold), so the measured end state is final.
5. **Re-base in-flight ghosts** by the scroll delta, so they stay where the
   reader sees them (§6.1).
6. **Measure layout boxes, diff, and cancel** the engine's live animations.
   Their painted frame is already in the capture.
7. **Play** the plan for the intent (table below). Under reduced motion,
   play the dissolve branch instead (§2.3).

Cards stay live DOM throughout. Hit-testing follows the painted (translated)
box, focus never moves, and nothing is ever captured. So the relay, the
offset seeking, the posing, the name budget and the suppression flags have
nothing left to do.

### 2.2 Motion by intent (full motion)

Durations and easings come from the `app.css :root` tokens and are read with
`getComputedStyle`, falling back to `src/lib/motion.ts` (add `T_ENTER_MS`,
`T_EXIT_MS`, `T_MS` beside `EASE`/`EASE_OUT`; "change the two together"
still applies). `--spring` is not used.

| Intent | Shared card, both ends near screen | Arrival (on screen after) | Departure (on screen before) | Shared card, an end far off | Reader's place |
| --- | --- | --- | --- | --- | --- |
| `lens` | glide `translate`, `--t-enter`, `--ease-out` (= today's group) | `rise`, delay 30ms + `min(i,6)·8ms` (≤48ms stagger), fill backwards | `sink` (card-depart), `--t-exit`, `--ease` | old place: ghost of the post-commit node sinks; new place: `rise` | `rewind` / restore inside commit; no anchor hold |
| `create` | glide | the morph's (`morphed`); fallback `drop` | — | as lens | none (as today) |
| `pin` / `unpin` / `edit-save` / `task` | glide (named card raised, z 2) | far named: `rise`/`drop` by direction | far named: copy `lift`/`settle` | as today | anchor hold (`hold()`, 400ms) |
| `trash` | glide | — | `sink` | — | anchor hold |
| `restore` | glide | — | `lift` | — | anchor hold |
| `purge` | glide | — | `fade` | — | anchor hold |
| `remote` | glide | `fade` (200ms) | `fade` | `fade` | anchor hold |
| `retag` | glide; on-screen targets also cross-fade text (pre-commit clone fades over the live card, `--t`) | `rise` | `sink` | as lens | anchor hold |
| `select` | chrome only (§4); cards untouched (checkboxes keep their CSS) | — | — | — | none |

"Near" keeps today's rule from `tuneFeedTransitionNames`: within half a
viewport of the screen. A shared card whose other end is pages away does not
streak across the screen; it leaves and enters like its neighbours.
`departed` keeps reporting `removed`/`up`/`down` for the edit-save toast and
focus.

### 2.3 Reduced motion: one opacity-only branch

Every intent takes the same branch. It is ≤150ms (`--t`), opacity only, and
nothing travels:

- **Departures:** ghost fades out in place.
- **Arrivals:** fade in in place, with no stagger.
- **Moved cards** (shared, painted ≠ new box): a ghost at the painted spot
  fades out while the live card fades in at its new box. This is what the root
  cross-fade did for lenses, minus the lost presses. The ghost is a
  post-commit clone, or the pre-commit copy when the content changed.
- **Content changed in place** (retag, edit-save, a pill label): pre-commit
  clone fades out over the live element.
- **Chrome keys:** the same rules.
- **Crumbs, chips, select pills, composer show:** their CSS entrances are
  zeroed by the reduce block today. They get fade overrides there (the
  `.toast` / `.overlay` pattern): `fade-in var(--t)`, leaving
  `fade-out var(--t-fast)`.
- The anchor hold stays: keeping the reader's place is not motion.

The rule then holds for pin, trash, restore, purge, edit, task and remote,
which hard-cut today, and for lenses, which no longer lose presses.

### 2.4 Arrivals without React flags

`MemoSlot` becomes a plain `<div className="memo-slot" data-memo={id}>`. The
engine watches the feed with a `MutationObserver` (`childList`, no subtree).
MO callbacks are microtasks, so they run after React's commit and before the
next paint.

- **Mounts inside `run()`:** claimed with `takeRecords()` in step 3; the run's
  own diff decides their arrival.
- **Mounts outside any run** (first load, paging, typed search, bootstrap
  pages, version-conflict refresh, tag rename): the MO callback plays the
  organic arrival. That is `rise` with `min(i,6)·8ms` stagger, fill
  backwards, only for slots on screen. Paging appends below the fold are
  bookkeeping only.

This replaces `enterSuppressRef`, `getEntering`, `MemoSlot`'s `intro`/
`entered` state, `.no-enter` and the slot's CSS `rise-in`. It also removes the
"insertBefore restarts the CSS entrance" hazard that MemoSlot works around.
Step 3 includes a probe confirming that a WAAPI animation survives React
moving its node.

### 2.5 What stays a View Transition

`src/lib/viewTransition.ts` shrinks to `src/lib/morph.ts` (~70 lines) with
`morph(kind, update)`, `skipMorph()` and `morphLive()`. It never runs under
reduced motion, in a hidden tab, or without the API, and both callers
already check that.

- **Send (`landCreated`, `App.tsx:3240-3305`).** The update runs
  `feedMotion.run("create", commit, { ids: [id], morphed: shared ? id : undefined })`.
  Names are on only for the morph:
  - `:root[data-morph="create"] .topbar`, so the text passes under the sticky
    bar;
  - `.composer` (closes from the typed height);
  - the field → new slot pair (inline, as today).

  The cards below are unnamed, so they glide as live FLIP under the pseudo
  tree. The `data-vt-create` / `--sent-dx/dy` / `.sent` rules stay as they
  are.
- **Lightbox** (`Lightbox.tsx:114`, `291`). Unchanged apart from the import.
- **Toast** keeps `view-transition-name: toast`, so the stack paints over
  both morphs' pseudo tree.

Everything else in the CSS view-transition section goes (§8, step 5b).

### 2.6 Constraints this design keeps

- It starts from the painted frame by construction, never from the layout box.
- No new capability. It covers the same verbs and the same choreography, and
  the keyframes are named copies of `card-depart`, `card-lift`, `rise-in`,
  `drop-in`, `crumb-out` and `fade-in/out`.
- Privacy: the engine writes nothing to the URL, `history.state` or
  `document.title`. Keys are app vocabulary (`topbar-action`, `composer`) or
  the opaque memo ids that are already in the DOM. Ghosts are in-page clones,
  `inert`, `aria-hidden`, with ids stripped (as `ghost()` does today).

## 3. Inventory of callers

### 3.1 `withViewTransition`

| # | Caller | Trigger | What it needs | Becomes |
| --- | --- | --- | --- | --- |
| 1 | `swapFeed` `App.tsx:2189-2222`: via `changeFeed` (`2280`), `returnToFeed` (`2243`) and `publishSemanticRef` (`2311`) | every discrete lens change (list in 3.3), Back/Forward (`popNav` `2992`), ⌂ (`showAll` `2431`), semantic ranking (`rewind: false`) | lens choreography; rewind or place restore inside the commit; nav intent reset; composer show/hide; top-bar chrome; skipped while the drawer is open or when the UA already animated Back (`morph: false`) | `run("lens", update, { rewind, motion })` (step 5a) |
| 2 | review midnight redeal `App.tsx:2798` | focus/visibility after midnight | new batch, same view, no rewind | `run("lens", …, { rewind: false })` (5a) |
| 3 | `adoptReviewSettings` `App.tsx:3079` | review settings change, a frame after the dialog exit | same as 2 | same (5a) |
| 4 | `enterSelectMode` `3095` / `exitSelectMode` `3108` | ⋯ › Select, Cancel, Esc | location pill ↔ "N selected" morph (`topbar-action`), select bar cascade; checkboxes are CSS | `run("select", …)` (4) |
| 5 | `mutateSelection` `3128` | a tap while the batch delete is armed | disarm morph of `select-delete` | `run("select", …)` (4) |
| 6 | `landCreated` `3265` | Send | text → card morph, composer closes, cards below glide, `drop` fallback | `morph("create", () => run("create", …))` (5b) |
| 7 | Empty Trash confirm `3745` | second press | disarm pill + every card leaves | `run("purge", …)` (5b) |
| 8 | `runBatch` from selection `3811` | Trash / Restore in select mode | verb exit (`lift` for restore), select bar folds back | `run(op, …)` (5b); the Undo path (`3812`) already uses `moveFeed` |
| 9 | `purgeMany` `3886` | Delete forever in Trash select mode | `fade` exit, select mode ends | `run("purge", …)` (5b) |
| 10 | `finishTagApply` `3996` | bulk tag dialog done | dialog closes, cards change text, select mode may end | `run("retag", …)` (5b) |
| 11 | `setEmptyTrashArm` `4219` / `setBatchDeleteArm` `4237` | arm, disarm, 4s timeout | pill label/width morph | `run("select", …)` (4) |
| 12 | `handleRemoveTag` `4417` | tag menu › Remove | card bodies cross-fade to tagless text; an active tag lens resets; the sidebar row leaves (TagTree's own FLIP) | `run("retag", …)` (5b) |
| 13 | `openLightboxFrom` `Lightbox.tsx:114` / `morphHome` `291` | tile click / close | tile ↔ photo snapshot morph | `morph("lightbox", …)` (6) |

### 3.2 `moveFeed` → `feedMotion.run` (wrapper `App.tsx:1207`)

| Caller | Intent | Notes |
| --- | --- | --- |
| `applyRemoteChanges` `1223` | `remote` | sync deltas from another tab/device; anchor hold |
| `saveEdit` land `3479` | `edit-save` | `departed` drives the toast and successor focus (`3472-3489`) |
| `runOptimisticMemoAction` `3529` (guess) and `3536` (settle / peel) | `pin` `unpin` `trash` `restore` | `holdFeedFocus` around the guess |
| `commitTaskBatch` `3645` | `task` | |
| `applyRemoval` `3675` | `purge` | single delete forever |
| `runBatch` Undo path `3812` | `trash` / `restore` | in place, no chrome |

These keep their call shape. `moveFeed(intent, ids, apply)` becomes
`feedMotion.run(intent, () => flushSync(apply), { ids })`.

### 3.3 `changeFeed` callers (all reach row 1)

`pickTag 2377`, `pickDay 2403`, `revealMemo 2467`, `searchAllMemos 2522`,
`toggleFacet 2537`, `clearRefinements 2551`, `applyPresetRange 2584`,
`clearDateRange 2597`, `clearStatsDrilldown 2604`, `openStatsDrilldown 2612`,
`applySavedFilter 2642`, `openTrash 2744`, `openReview 2776`, sort pick
`4958`, search × `5156`, search Esc `5195`, semantic off `5263`, Trash
search clear `5321`/`5340`. None of them change.

### 3.4 Feed changes that run no motion today (organic)

Typed search (`typeQuery`, deferred query); paging (`setRenderWindow` in the
sentinel observer, `2108`); first load and bootstrap pages (`1381`, `1458`,
`1481`); the idempotent-create fallback (`3364`); `reconcileVersionConflict`
(`3377`); tag meta (`4325`); `performTagRename` (`4380`). Today their
arrivals play the CSS `rise-in` and everything else cuts. After step 3 they
get the organic arrival (§2.4). Shared cards and departures still cut. That
keeps parity, because typed search ran no transition on purpose ("a view
transition per keystroke would be worse than none", `App.tsx:2084`).
`patchDateRange` (`2563`) also stays in place on purpose.

## 4. The top-bar chrome without snapshots

### 4.1 Mechanism

Chrome elements get `data-motion="<key>"`. The engine handles them in two
bands:

- **Top bar** (`.topbar`, sticky, z 40). Positions are measured relative to
  the bar's layout box, so the phone tuck/untuck is not counted twice. Ghosts
  go to a new `.topbar-ghosts` layer inside `.topbar` (zero box, `inert`,
  `aria-hidden`, `pointer-events: none`, like `.feed-ghosts`).
- **Column** (composer, banner, empty state). Positions use viewport
  coordinates, like cards, including the near/far rule. Ghosts go to a new
  `.column-ghosts` layer in `<main>` at z 30, the composer's layer. It sits
  over the cards that close the gap, as the `composer` group (z 1) did, and
  under the sticky bar.

Rules per key:

1. **Same element, same size and content:** glide `translate` from the old
   spot (`--t-enter`, `--ease-out`).
2. **Content or size changed, or a different element** (`topbar-action` is
   shared by `.loc-trigger`, `.select-count`, `.trash-empty-button` and
   `.review-config-button`): a cross-fade glide. A pre-commit clone and the
   live element both glide from the old spot to the new one at natural size.
   The clone fades out while the live one fades in over 150ms (`--t`, see
   decision D1). This is the natural-size image pair the CSS pins today
   (`app.css:5401-5426`), now on live DOM.
3. **Key only before:** exit ghost with the key's verb. Trail parts use
   `crumb-out` (chips, view trail, select pills, `trash-select`, context
   tag). The composer sinks (`card-depart`, as its old only-child snapshot
   did). Everything else uses `fade-out`.
4. **Key only after:** the element's own CSS entrance plays (`crumb-in`,
   `rise-in`). Keys without one get `fade-in` 200ms with a 30ms delay,
   today's only-child default.
5. **Column key with an end far off-screen:** exit plus arrival, never a
   glide. This also fixes the composer streaking down from far above on a
   rewind, which the always-named composer can do today.

### 4.2 Element by element

| Element | Today (inside the snapshot) | With the engine |
| --- | --- | --- |
| Location pill `.loc-trigger` | `topbar-action` group glides; labels hand over in 140ms at natural size | rule 1, or rule 2 when the label changes (tag ↔ All memos, sort suffix) |
| Pill ↔ "N selected" / Empty Trash / Review settings | shared name, cross-element morph | rule 2 |
| ⌂ and ancestor crumbs (`Crumbs.tsx`) | live CSS (`crumb-in` cascade, `.is-settling`, `.crumb-ghosts` fold-back) inside the bar image, which also cross-faded | unchanged live CSS, no longer doubled by a bar cross-fade; reduced motion gets fade overrides |
| `.loc-sep` | own group, glides | rule 1 |
| Filter chips (`FilterChip`, day / stats / range / facet) | glide on trail width change, morph on relabel, `crumb-out` on removal | rules 1 / 2 / 3 (`crumb-out`); entrance stays `crumb-in` + `chipDelay` |
| Trash / Review trail `.view-trail` | old: `crumb-out` 140ms; new: none (live cascade); Trash ↔ Review morphs | rule 3 `crumb-out`; arrival is the live cascade; Trash ↔ Review uses rule 2 |
| `.trash-select-button` | `crumb-out` / none | rule 3 / rule 4 `fade-in` |
| `.select-delete` arm/disarm | own group, width morph | rule 2 in place |
| Select bar siblings (`.select-all`, `.select-tag`/`.select-restore`, `.select-exit`) | unnamed: cross-faded with the bar image | new keys; `crumb-in` on mount (CSS), `crumb-out` ghost on leave |
| `.searchbox` | own group; only-child fade out (`--t-fast`) / in (`--t`) | rules 1–4 with those fades |
| Composer hide/show (Trash, Review: `hidden` at `App.tsx:5426`) | `composer` group; the new snapshot plays `rise-in`; `swapFeed` finishes the live `rise-in` so it doesn't double (`2203-2209`) | hide: ghost sinks in `.column-ghosts` while the cards glide up under it. Show: removing `hidden` replays the composer's own CSS `rise-in`, which is now the entrance. The `finish()` hack is deleted |
| Composer context tag (`composer-context-tag`) | `crumb-in` / `crumb-out` via names only | CSS `crumb-in` on mount, rule 3 `crumb-out` ghost |
| Phone composer fold (`data-searching`, `app.css:5544-5570`, `4eae1b6`) | CSS grid-rows/filter transition, live inside the composer's new image | stays CSS. Glides are `translate` relative to the layout box, so they compose with the fold moving the boxes. Under reduced motion the engine finishes the fold before measuring |
| `.search-summary` fold | live CSS | unchanged; same composition |
| `.review-banner` | own group (steady across redeals) | column key; the count changes on redeal, so rule 2 |
| `.feed-empty` | own group; CSS `rise-in` | column key; rule 4 entrance is its CSS `rise-in`; rule 3 `fade-out` |
| `.sync-notice` | own group | own `@starting-style` fold; name dropped |
| `.topbar` band | own group (z 2) so captured cards don't paint over it | not captured at all except during the send morph. Live cards slide under the sticky bar by plain stacking |
| `.toast` | own group (z 6) | keeps its name for the two morphs |

## 5. Focus and reading place

### 5.1 Place capture and restore (`navHistory.ts:325-394`)

- `captureFeedPlace` and `restoreFeedPlace`'s six-frame re-aim read
  `getBoundingClientRect()`, which includes a running glide. After the
  rewrite, glides run during lens swaps, so both switch to a shared
  `layoutRect(el)`: the rect minus computed `translate` and the own-transform
  translation, i.e. `measure()` lifted out of `feedMotion.ts`. A place noted
  mid-glide is then the card's settled place. The re-aim corrects only real
  layout drift (content-visibility) and never fights a glide. Step 2 ships
  this first, on its own.
- `restoreFeedPlace` keeps its `SCROLL_JUMP_EVENT` (the phone tuck ignores
  app scrolls).

### 5.2 Effect order inside the commit

`run` measures only after `commit` returns. Inside `commit` the order must
stay exactly as it is:

1. `flushSync(apply)`. `apply` sets lens state, `navIntentRef`,
   `pendingPlaceRef` and `placeTick`. For a rewind it also resets the render
   window (`2195`).
2. Layout effects run in declaration order:
   1. the query-scroll effect (`2090-2094`), which does `scrollTo(0, 0)` on a
      new query key;
   2. the place restore (`2299-2308`). It is declared after (1) so a restored
      place wins. If the place is deep in the feed it first widens the render
      window; that synchronous re-render is still inside the same `flushSync`.
   3. the nav recorder (`2836`), which reads `navIntentRef` set by `apply`;
   4. the title (`2911`), after the recorder so each entry keeps its title.
3. `finally`: `navIntentRef = "replace"`. Then `if (rewind) scrollTo(0, 0)`.
4. Engine: claim mounts, materialize the band, re-base ghosts, measure, play.
5. Later: `revealMemo`'s effect (`2486`, `useEffect` + rAF) scrolls the
   revealed card into view after the run's rewind. The `createdPlacement`
   check follows.

Hazard: a lens state that lands a render late, outside the flush, gets only
organic treatment. `swapQuery`'s leap (`queryLeapRef`, `2314`) is what keeps
control-set searches inside the flush. Step 5a adds a test that a control-set
search's arrivals are claimed by the run.

### 5.3 Focus

- `holdFeedFocus` / `refocus` (removals), `armFocusFloor` (self-removing
  controls), `restoreLocationFocusRef` (leaving select mode) and edit-save's
  successor focus run in the same task as before. Nothing changes.
- The relay's hand-made focus (`focusPressed`) goes away. Presses are native
  again, so a mousedown focuses what it lands on.
- Ghosts are `inert`, `aria-hidden`, with ids stripped. A chrome clone of
  `.select-count` keeps no live region in the accessibility tree.
- A focused element that glides keeps its ring and moves with it (live DOM).

## 6. Interruption, content-visibility, long feeds

### 6.1 Interruption semantics

- **R1 — Every run starts from the painted frame.** The capture reads rect
  plus computed opacity. Glides, arrivals and cross-fades in flight are all
  live-element animations, so their current frame is what gets captured.
- **R2 — Replace, don't stack.** The engine's live animations are cancelled
  in the same task, after capture, and restarted from the painted frame. No
  frame paints in between.
- **R3 — Ghosts finish.** An exit in flight keeps playing. If the commit
  scrolled (rewind or restore), each ghost's `top` shifts by the scroll delta
  so it stays where the reader sees it.
- **R4 — Unseen arrivals.** A slot still in its stagger delay (opacity 0)
  counts as unseen. If it is still present after the change, it arrives again.
  If it is gone, it gets no ghost.
- **R5 — A second lens switch mid-glide.** Card A is drawn at y=250 on its
  way from 400 to 100 when the reader picks B. If A is in B, it glides from
  250. If not, a ghost sinks at 250. Acceptance: no card's painted top jumps
  more than 1px across the second click's frame. Today's VT measured
  58–73px.
- **R6 — The reader scrolls mid-glide.** Glides are relative to layout boxes,
  so everything scrolls together. The in-place anchor hold already yields to
  wheel, touch and key input.
- **R7 — A press mid-glide** lands on the live card where it is drawn. A press
  on a ghost falls through to whatever is under it. A press on a chrome key
  mid-cross-fade hits the live (new) element.
- **R8 — Morphs.** Any non-`create` run skips a live morph first: the send's
  last frames land. The case is rare, and the alternative is reading pseudo
  offsets again. A morph starting during glides captures the painted
  participants, and the unnamed live cards keep gliding under its pseudo tree.
  `run("create")` inside the morph cancels a composer glide in flight in step
  6 of the run.
- **R9 — `settle()`** lands everything on logout and unmount, as today.

### 6.2 Content-visibility estimates

Slots are `content-visibility: auto; contain-intrinsic-size: auto 120px`
(`app.css:~3027`). Off-screen slots never rendered stand at 120px and take
their height a frame later. A VT's new capture happened after that frame; a
live FLIP measures before it. So:

- **Post-commit band:** walk slots from one viewport above the screen
  downward, setting `style.contentVisibility = "visible"`. Each forced slot
  shifts the ones after it, so keep going until a forced slot's top passes
  one viewport below the screen, then measure. Release two frames later, the
  existing `fresh` trick (`feedMotion.ts:406-421`). By then their real sizes
  are remembered (`auto`).
- **Pre-commit capture forces nothing.** A card whose painted position is
  still an estimate is off-screen, so a slightly wrong start point is never
  seen.
- `.memo-feed.is-small` (≤ `SMALL_FEED` = 24 rows) already renders
  everything.
- Acceptance probe P6: after the last glide frame, no slot moves for 500ms
  (no late materialization jump).

### 6.3 Very long feeds

- **The band is the budget.** Seeking is O(log n), and capture, measure and
  animation are O(band): about 3 viewports × ~8 cards ≈ 25–40 slots. A hard
  cap of 64 animated slots per run (beyond it, cut and log in dev) replaces
  the 32-name budget as a performance guard, not a correctness one.
- The key-set diff is O(n) with no layout reads (dataset only).
- A rewind collapses the render window to `FEED_PAGE` (80) inside the same
  commit, so a lens swap from 600 rendered rows unmounts them before the
  measure.
- Ghosts are on-screen only (≤ ~10). Under reduced motion, moved cards clone
  the post-commit node (≤ ~10).
- The MutationObserver sees paging appends. They are off-screen, so it only
  does bookkeeping.
- Acceptance probe P5: a lens swap from row ~400 of a 600-memo fixture takes
  no longer (long task around the click) than the VT baseline + 10%.

## 7. Verification harness (headless Chrome over CDP)

The desktop Browser pane cannot verify motion. Its tab is hidden, view
transitions are skipped, CSS and WAAPI animations freeze, and rAF never
fires. Use it for static DOM checks only. Every motion check below uses
headless Chrome, which reports `visibilityState: "visible"`.

**Setup** (scratchpad, not committed, matching past practice; see decision
D6):

1. `npm run build`. Serve a fixture with
   `wrangler pages dev dist --persist-to .wrangler/<fixture> --port 879x`
   (a gitignored `.claude/launch.json` entry; remove it by hand afterwards).
   Fixtures:
   - `readme-state` (demo notebook);
   - a new `motion-long` (600 memos seeded through `/api/import`, 12 per
     chunk to keep `createdAt`, with some tall memos and image tiles).
2. Launch `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9333 --user-data-dir=<scratch>/motion-profile`.
   Use one Chrome per profile dir.
3. Drive it from Node 22 with raw CDP (global `WebSocket`). Log in with
   `fetch('/api/auth/login', …)` evaluated in the page, then reload.
4. Re-apply emulation on every session, because it is per-session and lost
   when the socket closes: `Emulation.setDeviceMetricsOverride` 1440×900 DSF 2
   (desktop) or 390×844 mobile + touch, and
   `Emulation.setEmulatedMedia({ features: [{ name: "prefers-reduced-motion", value: "reduce" }] })`
   for reduced-motion runs. Wait ~400ms for relayout.

**Probes** (injected with `Runtime.evaluate`, results read back as JSON):

| Probe | How | Pass |
| --- | --- | --- |
| P1 painted continuity | real clicks (`Input.dispatchMouseEvent` move → press → 90ms → release) on tag row A, then on row B 110ms later. A rAF recorder started **after** the first click logs each slot's `data-memo`, `getBoundingClientRect().top` and computed opacity per frame. Cross-check with `Page.startScreencast` pixels if the two disagree | no slot's top jumps >1px across B's frame; motion ends ≤ `--t-enter` + 48ms + a frame after B |
| P2 press-through | start a lens glide, then 80ms later real-press a visible card's ⋯ at its painted position | `.action-menu` opens on that card. Variants: second press on an armed Empty Trash at 60ms; under reduced motion |
| P3 reduced-motion audit | with reduce emulated, trigger each intent; every 16ms for 250ms list `document.getAnimations()` keyframe properties and `getComputedTiming()` | only `opacity` in any keyframe; every duration ≤150ms; no slot rect changes except in the single commit frame |
| P4 filmstrip parity | on trigger + `setTimeout 0`, pause `getAnimations().filter(a => a.playState !== "finished")`, step `currentTime` 0→300ms by 20ms, `Page.captureScreenshot` per step (full viewport: `clip` is in document coordinates), stitch a grid in a second target | owner compares side by side with the Step 0 baseline |
| P5 long feed cost | `Tracing.start` (`devtools.timeline`) around a lens swap from row ~400 of `motion-long` | long task ≤ baseline + 10%; ≤64 animations running |
| P6 late layout | lens swap into tall cards with rewind; record slot tops for 500ms after the last glide | no movement after the last glide frame |
| P7 place restore | scroll deep, pick a tag, Back (also: pin, then Back within 200ms) | anchor card lands at its saved offset ±1px; no re-aim drift during glides |
| P8 transition census | wrap `document.startViewTransition` to log each call's caller (`data-morph`) | after 5b, only `create` and `lightbox` ever start one |

## 8. Migration: seven independently shippable steps

Each step is one commit, leaves the app consistent, and runs `npm test` and
`npm run build` before it is offered. Tests are named by file. "Baseline" means
Step 0's recordings.

### Step 0 — Baseline (no `src/` change)

Record P1–P8 and filmstrips on today's build: lens pick, Back with place,
Trash/Review entry and exit, select mode, pill arming, send (also scrolled),
trash/pin/restore/purge, tag removal, desktop and 390px, both motion settings.
Keep them in the session notes folder and quote the numbers in this doc's
appendix. Without this, "parity" can't be judged.

### Step 1 — Reduced motion dissolves in-place changes

- **Change:** `feedMotion.ts` only. The `canAnimate()` reduced-motion cut
  becomes the §2.3 branch for in-place intents.
- **Ships:** the house rule holds for pin, trash, restore, purge, edit, task
  and remote.
- **Tests (`tests/feedMotion.test.ts`):** replace "only commits under reduced
  motion, still keeping the reader's place" with "dissolves under reduced
  motion: opacity-only keyframes ≤150ms, no translate, place still held".
  Add "a neighbour closing the gap cross-fades instead of gliding" and "a
  trashed card's ghost fades in place".
- **CDP:** P3 on trash, pin, restore, purge, edit-save and task; P4 under
  reduce for a trash near the top.

### Step 2 — Read layout boxes wherever the feed is measured

- **Change:** add `layoutRect` / `paintedRect` (exported from `feedMotion.ts`
  or a small `src/lib/feedBoxes.ts`). `feedMotion.measure`,
  `captureFeedPlace` and the re-aim in `restoreFeedPlace` use them.
- **Ships:** a place noted, or re-aimed, during an in-place glide is right.
  There is no other visible change.
- **Tests (`tests/navHistory.test.ts`):** "a card mid-glide is captured at its
  settled place"; "re-aim ignores a running glide". `feedMotion.test.ts`
  stays green.
- **CDP:** P7, pin then Back within 200ms.

### Step 3 — Arrivals belong to the engine

- **Change:**
  - `MemoSlot` becomes a plain div. `FeedItem` drops `getEntering` and
    `delay`.
  - Delete `enterSuppressRef`, `getEntering`, `.no-enter` and the slot's CSS
    `rise-in`.
  - The engine gains the MutationObserver path (§2.4).
  - `withViewTransition`'s update claims the mounts its own update made (one
    call after `update(true)`), so the snapshot still owns lens and send
    arrivals until 5a/5b. No caller changes.
- **Ships:** one owner for slot entrances, and no React plumbing.
- **Tests:**
  - `feedMotion.test.ts`: "organic mounts rise with ≤48ms stagger, on screen
    only"; "a run's own mounts get no organic arrival"; "mounts inside a view
    transition's update are left to the snapshot"; "under reduced motion
    organic arrivals fade (150ms)".
  - `tests/createLanding.dom.test.tsx`: the `slotClass contains "no-enter"`
    assertion becomes "the created slot gets no engine arrival inside the
    transition".
  - `feedCards.dom` stays green.
- **CDP:** P4 first-load cascade vs baseline; typed search arrivals; a paging
  append (no visible arrival below the fold); probe that a WAAPI arrival
  survives a React reorder mid-flight; P3 for organic arrivals.

### Step 4 — Chrome motion; chrome-only scene changes leave View Transitions

- **Change:**
  - `data-motion` keys (§4.2) on the JSX, with `FilterChip` gaining a
    `motionKey` beside `transitionName`.
  - The two ghost layers.
  - The engine's chrome pass (rules 1–5 and the reduced-motion variant),
    probably as `src/lib/chromeMotion.ts`, called only from `feedMotion.run`.
  - Callers #4, #5 and #11 move to `run("select", …)`.
  - VT names stay in CSS for the remaining VT callers.
  - The reduce block gains fade overrides for `.crumb`, `.crumb-sep` (incl.
    `.is-leaving`, `.is-settling`), `.filter-chip`, `.select-bar` pills and
    the composer's show.
- **Ships:** select mode and pill arming are live and clickable throughout.
- **Tests:**
  - `feedMotion.test.ts` (jsdom band with stubbed rects): "a key glides from
    where it was drawn"; "a changed label cross-fades: clone out, live in,
    natural size"; "a leaving trail key folds back with crumb-out"; "chrome
    under reduced motion is opacity-only"; "ghost layers are inert and
    aria-hidden, ids stripped".
  - `tests/overlayFeedback.dom.test.tsx`, `tests/uiA11yRegression.dom.test.tsx`
    and the select-mode DOM tests stay green.
- **CDP:** P4 for select enter/exit and arm/disarm (both pills); P2 second
  press on armed Empty Trash at 60ms; P3.
- **Gate:** the owner signs off the pill morph side by side with the
  baseline. This is the main taste risk (§9). If it fails, stop here: steps
  1–4 stand alone.

### Step 5a — Lens swaps through the engine

- **Change:**
  - `swapFeed`'s body becomes
    `feedMotion.run("lens", update, { rewind, motion: drawerOpen || !morph ? "none" : "auto" })`,
    with `update` = today's flush + nav intent reset + rewind scroll. The
    composer `finish()` hack is deleted.
  - Callers #2 and #3 move to `run("lens", …, { rewind: false })`.
  - The engine gains the lens plan (§2.2), the content-visibility band (§6.2),
    ghost re-basing (R3), and composer show/hide via the column layer.
  - `paintedTransitionOffsets` stays only for runs that start over a batch or
    send VT, which remain until 5b.
- **Tests:**
  - `feedMotion.test.ts` lens suite: "rewind glides in viewport space"; "a
    shared card from far off leaves and enters instead of streaking";
    "arrivals rise 30ms + ≤48ms"; "departures sink"; "a second lens run
    continues from the painted frame"; "reduced-motion lens dissolves";
    "the forced content-visibility band is set and released".
  - `tests/navigation.dom.test.tsx`: "a tag pick starts no view transition and
    runs one lens run" (spy `startViewTransition` and `Element.animate`);
    "Back lands on the saved card with motion on"; "a restored place wins over
    the query-scroll inside one run" (effect order); "a control-set search's
    arrivals are claimed by the run".
  - `navigationChrome.dom` / `navigationControls.dom` stay green.
- **CDP:** P1, P2, P4 (owner gate), P5, P6, P7, P3 for lenses; 390px with the
  phone composer fold and a drawer pick (parity: a cut, see D3).

### Step 5b — Remaining scene changes and Send

- **Change:**
  - Callers #6–#10 and #12 move to `run(…)`. `landCreated` becomes
    `morph("create", () => run("create", …))`. Under reduced motion or without
    the API it is `run("create")` alone: a drop or fade arrival, and the
    composer cross-fades from its pre-commit clone.
  - Delete `tuneFeedTransitionNames`, `data-vt-exit`, `transitionUpdating`,
    `onTransitionUpdate`, `feedMotion.attach`, `paintedTransitionOffsets`,
    `readPaintedOffsets`, `poseAtPaintedFrame`, `view-transition-class:
    memo-card`, `MemoSlot`'s `vtName`, and the CSS VT rules for cards, chips,
    trail, select, searchbox, banner, empty state, sync notice, context tag
    and the always-on `topbar` / `composer` names (now under
    `:root[data-morph="create"]`).
  - Delete the reduce block's VT rules (`:root { view-transition-name: root }`
    etc.).
- **Tests:**
  - `tests/viewTransition.test.ts`: delete the `tuneFeedTransitionNames` and
    verb suites; add `morph()` tests ("names live only during the morph";
    "never starts under reduced motion"; "skipMorph lands it").
  - `tests/createLanding.dom.test.tsx`: "Send starts a create morph with
    `data-morph=create` and clears it on finish"; "under reduced motion no
    transition starts and the card fades in".
  - `tests/bulkTags.dom.test.tsx` and `tests/reviewFixes.dom.test.tsx` stay
    green.
  - `feedMotion.test.ts`: "retag cross-fades on-screen targets"; "batch verbs
    exit with lift / sink / fade"; "create without a morph drops in".
- **CDP:** P4 Send vs baseline: the text travel is unchanged and the cards
  below glide live. Also Send while scrolled (the text passes under the bar),
  batch trash/restore from selection, Empty Trash, tag removal, and P8
  (census).

### Step 6 — Retire the relay and the old module

- **Change:**
  - `viewTransition.ts` becomes `src/lib/morph.ts` (~70 lines), with the press
    relay deleted. Lightbox imports `morph`.
  - Rename `data-vt` → `data-memo` (`navHistory.ts:312-317`, `revealMemo`,
    edit-save, `landCreated`, tests).
  - Sweep comments that say "rides a view transition" (`App.tsx:1195-1200`,
    `2176-2188`, `Crumbs.tsx:10-13`, `FilterChip.tsx:12-15`, `app.css`
    section headers).
- **Tests:** `tests/viewTransition.test.ts` → `tests/morph.test.ts`. The relay
  suite is deleted; its scenario is covered by P2 and by cards being live.
  `tests/lightbox.dom.test.tsx` stays green (tile names cleared after the
  morph).
- **CDP:** P2 during a send morph and a lightbox open. Expected: presses on
  the composer, the new card or the top bar are lost for ≤240ms during a
  send; every card stays live.
- **Owner decision D4:** accept that window, or keep a ~30-line relay scoped
  to the morph's 3–4 named parts.

## 9. Risks, and what would make the owner say no

**Risks**

1. **Cross-element pill morph parity (highest).** A snapshot pair
   cross-fades over transparent with `plus-lighter`. Live DOM can't isolate a
   clone with its element that way, so a changed label may dip slightly
   mid-fade where the two overlap. Mitigations:
   - glide-only when the label didn't change, so identical labels never
     cross-fade;
   - the clone sits over an opaque live pill;
   - the step 4 gate compares filmstrips side by side.
2. **Live DOM shows what snapshots froze.** Mid-glide, an image finishing its
   decode, a font swap or a hover state under a still pointer now shows.
   Image tiles reserve their boxes (`a5e47ad`), and the forced band covers
   content-visibility. Hover on a card gliding under the pointer is new and
   minor.
3. **Cost on phones.** The synchronous band materialization renders up to ~3
   viewports of cards in the click task. A VT renders the new state before
   `ready` too, but in its own frame. P5 is the gate.
4. **Regressing the last month's fixes.** The place return (`4eae1b6`), the
   focus floor, nav intents and the deferred query landing in the flush could
   regress. The plan keeps `changeFeed`, `returnToFeed`, `noteLeavingPlace`,
   `popNav` and the effect order untouched and swaps only the motion call.
   5a adds an order test.
5. **Reduced-motion cross-fades show two copies at 50%** for moved cards. The
   root dissolve does the same today, but the owner may prefer a sequential
   out-then-in (75 + 75ms). See D2.
6. **Browsers without View Transitions** (older Safari/Firefox) start getting
   lens glides, because WAAPI is everywhere. It is a side effect, not a goal,
   but it is a behaviour change.
7. **Presses lost during the two remaining morphs** (step 6, D4).

**What would make the owner say no**

- The pill and chip morph looks worse than today in the step 4 or 5a
  filmstrips.
- The Send morph changes at all. By design it shouldn't: same CSS, same
  timing, only the cards below become live.
- P1 doesn't reach ≤1px, or P5 regresses more than 10%. The rewrite's case is
  continuity and simplicity; without the first it isn't worth the churn.
- The line count grows. Estimate:

  | Part | Change (lines) |
  | --- | --- |
  | `viewTransition.ts` 372 → `morph.ts` ~70 | −300 |
  | `feedMotion.ts` 543 → ~700, plus `chromeMotion.ts` ~200 | +360 |
  | `App.tsx` (flags, MemoSlot, hacks out; 14 call sites change shape) | ~−40 |
  | `app.css` (VT section ~165 → ~55; slot entrance out; reduce fades in) | ~−110 |
  | **Net source** | **about −90** |
  | Tests: `viewTransition.test.ts` 276 → ~80; `feedMotion.test.ts` 236 → ~550 | |

  If the engine ends up much bigger than that, it's a fair reason to stop
  after step 4.
- The time cost for a feature-frozen app. Steps 1–3 are small and fix real
  rule breaks, so they stand alone. 4–6 are the rewrite proper.

## 10. Decisions for the owner

- **D1.** Chrome label hand-over: today's literal 140ms, or `--t` (150ms) so it
  sits on a token? Recommended: `--t`.
- **D2.** Reduced motion for moved cards: simultaneous cross-fade (as the root
  dissolve does today) or out-then-in? Recommended: cross-fade.
- **D3.** Phone drawer open during a pick: keep today's cut, or let the feed
  move behind the closing drawer? Recommended: keep the cut in 5a, then A/B
  as a follow-up.
- **D4.** Step 6: accept ≤240ms of lost presses on the morphing parts during a
  send or lightbox morph, or keep a scoped ~30-line relay? Recommended:
  accept.
- **D5.** Lens glides in browsers without View Transitions (side effect of
  WAAPI): fine? Recommended: yes.
- **D6.** The CDP harness: scratchpad only (as before) or committed under
  `scripts/`? Recommended: scratchpad.

## 11. As built

The owner took every recommendation (D1–D6). Where the code departs from
the sketches above:

- **Send keeps `data-vt-create`** rather than `data-morph="create"`; the
  rules it keys are the same. The composer's context tag carries a name of
  its own during the morph (`composer-context-tag`), or it is baked into
  both composer snapshots and shows twice for a frame.
- **Retag moves the card, not its text.** A card's own stage
  (`card-stage is-morphing`) already cross-fades its content, so the engine
  plays no hand-over of its own; it would have doubled the text.
- **Kept CSS.** `::view-transition-group(*)` timing and the old/new
  only-child defaults stay for the morphs. The reduced-motion block keeps
  its root-capture rules for the splash → login brand-mark dissolve.
- **Step 6.** The module keeps its name and `data-vt` keeps its name (the
  contracts above). With the relay gone, presses on a morph's named parts
  (the new card, the composer, the top bar, the lightbox) are lost for at
  most 0.24s (D4), and every card stays live. A held mouse press on a card
  or pill that is gliding could still split across two elements, so the
  click went to their common ancestor. The motion layer therefore captures
  the pointer on what was pressed while it carries it (`holdPress`), as a
  touch already does.

## Appendix A — CSS that goes, stays, or moves

| Rule (app.css) | Fate |
| --- | --- |
| `.memo-slot { animation: rise-in }`, `.no-enter`, `view-transition-class: memo-card` (~3036–3053) | delete (steps 3 / 5b) |
| `:root { view-transition-name: none }`, `::view-transition { pointer-events: none }` (5312, 5322) | keep (the morphs still must not capture the root) |
| `::view-transition-group(*)`, old/new only-child defaults, `.memo-card` arrivals, `data-vt-exit` lift/fade (5323–5345, except 5337) | delete (5b) |
| Send rules `data-vt-create`, `sent-seat`, `sent-gather`, composer clip (5337, 5356–5373) | keep, keyed on `data-morph="create"` |
| Chip / trail / topbar-action / select-delete / searchbox natural-size and fold rules (2063–2067, 5379–5426) | delete (5b); behaviour moves to the chrome pass |
| Stacking table and z-indexes for groups (5427–5451) | shrink to topbar, composer and toast for the send morph |
| Lightbox rules (4081–4093) | keep |
| Reduce block VT rules (5896–5907) | delete; add opacity fades for crumbs, chips, select pills and the composer show |
| `view-transition-name` on `.topbar`, `.loc-sep`, `.view-trail`, `topbar-action`, `select-delete`, `.searchbox`, `trash-select`, `.composer`, `composer-context-tag`, `.sync-notice`, `.review-banner`, `.feed-empty` | delete (5b); `.topbar` and `.composer` move under `:root[data-morph="create"]`; `data-motion` keys take over |
| `view-transition-name: toast` | keep |
