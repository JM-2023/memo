import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { diffLines, isTaskMarkFlipOnly, visualLinesOf, type DiffOp } from "../lib/lineDiff";
import type { MemoImage } from "../lib/types";

/**
 * Scene-morph stage for a memo card. The card swaps between two scenes —
 * rendered content ("view") and the in-place editor ("edit") — and both
 * swaps and content updates animate instead of snapping:
 *
 *  - view ↔ edit: the outgoing scene fades over the incoming one while the
 *    stage's real height glides between the two measured heights, so the
 *    page never jumps.
 *  - saved edits (and remote content updates) replay their line diff:
 *    removed lines shutter closed in place, surviving lines glide to their
 *    new positions, added lines rise in staggered.
 *
 * Frame-rate discipline: every per-line animation is transform/opacity/
 * clip-path (compositor-only); the single height tween on the stage is the
 * only property that touches layout.
 *
 * Mechanics: a render-phase state adjustment keeps BOTH scenes mounted in
 * the commit that changes them (scene containers are keyed, so the live
 * editor's DOM — including the user's typed pixels — survives its role
 * flip to "outgoing"). A layout effect then measures, pins the stage
 * height, and drives everything through WAAPI before first paint.
 */

const EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";
const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
const SWAP_HEIGHT_MS = 220;
const REPLAY_HEIGHT_MS = 260;
/** Above this many combined visual lines the replay downgrades to a plain
    cross-fade — hundreds of clone layers would tax the compositor without
    telling a legible story. */
const REPLAY_LINE_BUDGET = 140;

interface Snap {
  editing: boolean;
  content: string;
  mediaKey: string;
  images: MemoImage[];
}

type MorphKind = "toEdit" | "swap" | "replay";

interface MorphPlan {
  kind: MorphKind;
  prev: Snap;
  ops: DiffOp[] | null;
}

interface MemoStageProps {
  editing: boolean;
  content: string;
  /** Stored-image ids + external urls joined; "" when the memo has no media. */
  mediaKey: string;
  images: MemoImage[];
  /** The full steady view body (header + content + media + select overlay). */
  view: ReactNode;
  /** The live editor; null when not editing. Held across its exit morph. */
  editor: ReactNode | null;
  /** Pixel-identical, inert re-render of a past view body (measure layer). */
  renderGhost: (content: string, images: MemoImage[]) => ReactNode;
  /** Just the media grid of a given state; null when it has none. */
  renderGhostMedia: (content: string, images: MemoImage[]) => ReactNode | null;
  /** One inert rendered line (replay overlay clones). */
  renderLine: (raw: string, nextRaw?: string) => ReactNode;
}

function buildPlan(prev: Snap, next: Snap): MorphPlan | null {
  if (!prev.editing && next.editing) return { kind: "toEdit", prev, ops: null };
  const contentChanged = prev.content !== next.content || prev.mediaKey !== next.mediaKey;
  if (prev.editing && !next.editing && !contentChanged) return { kind: "swap", prev, ops: null };
  // Save (edit → view) or a remote update (view → view) with real changes.
  const oldLines = visualLinesOf(prev.content).map((line) => line.raw);
  const newLines = visualLinesOf(next.content).map((line) => line.raw);
  if (oldLines.length + newLines.length > REPLAY_LINE_BUDGET) return { kind: "swap", prev, ops: null };
  const ops = diffLines(oldLines, newLines);
  // A view→view update that only flips checkbox marks lands with no morph at
  // all: the row keeps its DOM node (stable line keys), so the box's own CSS
  // transition tells the story — for the local toggle's confirmation the view
  // already shows the flipped state, and a replay would re-narrate it.
  if (!prev.editing && !next.editing && prev.mediaKey === next.mediaKey && isTaskMarkFlipOnly(ops)) return null;
  return { kind: "replay", prev, ops };
}

export function MemoStage({ editing, content, mediaKey, images, view, editor, renderGhost, renderGhostMedia, renderLine }: MemoStageProps) {
  const [snap, setSnap] = useState<Snap>(() => ({ editing, content, mediaKey, images }));
  const [morph, setMorph] = useState<MorphPlan | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const animsRef = useRef<Animation[]>([]);
  /** Identity guard: a settle callback only lands if its plan is still live. */
  const morphRef = useRef<MorphPlan | null>(null);
  const editorHeldRef = useRef<ReactNode>(null);
  if (editor) editorHeldRef.current = editor;

  // Render-phase adjustment: when the scene or (while viewing) the content
  // changes, commit BOTH old and new scenes at once so the morph can run.
  // Content changes that arrive while editing update nothing here — the
  // pre-edit view stays the replay baseline.
  const sceneChanged = snap.editing !== editing;
  const viewContentChanged = !editing && (snap.content !== content || snap.mediaKey !== mediaKey);
  if (sceneChanged || viewContentChanged) {
    const prev = snap;
    setSnap({ editing, content, mediaKey, images });
    setMorph(buildPlan(prev, { editing, content, mediaKey, images }));
  }

  useLayoutEffect(() => {
    morphRef.current = morph;
    const stage = stageRef.current;
    if (!morph) {
      // Settle commit: extras unmounted, natural height already equals the
      // animated end value, so releasing the pin is invisible.
      for (const anim of animsRef.current) anim.cancel();
      animsRef.current = [];
      if (stage) stage.style.height = "";
      return;
    }

    const plan = morph;
    const target = plan.kind === "toEdit" ? editRef.current : viewRef.current;
    const outgoing = plan.kind === "toEdit" ? viewRef.current : plan.prev.editing ? editRef.current : ghostRef.current;
    const finishNow = () => {
      for (const anim of animsRef.current) anim.cancel();
      animsRef.current = [];
      if (stage) stage.style.height = "";
      if (morphRef.current === plan) setMorph(null);
    };
    if (!stage || !target || !outgoing || stage.offsetWidth === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finishNow();
      return;
    }

    // ---- Measure everything first (one layout pass), then write. ----
    // Fractional heights (not offsetHeight): the tween must land exactly on
    // the real layout height or the settle swap shows a sub-pixel snap.
    const interruptedHeight = animsRef.current.length > 0 ? stage.getBoundingClientRect().height : null;
    const h0 = interruptedHeight ?? outgoing.getBoundingClientRect().height;
    const h1 = target.getBoundingClientRect().height;

    interface CloneTrack {
      el: HTMLElement;
      keyframes: Keyframe[];
      options: KeyframeAnimationOptions;
    }
    const cloneTracks: CloneTrack[] = [];
    let headerEl: HTMLElement | null = null;

    if (plan.kind === "replay" && plan.ops) {
      const overlay = overlayRef.current;
      const ghost = ghostRef.current;
      const stageTop = stage.getBoundingClientRect().top;
      const tops = (root: HTMLElement | null, selector: string): number[] => {
        const host = root?.querySelector(selector);
        if (!host) return [];
        return [...host.children].map((child) => child.getBoundingClientRect().top - stageTop);
      };
      const boxTop = (root: HTMLElement | null, selector: string): number | null => {
        const el = root?.querySelector(selector);
        return el ? el.getBoundingClientRect().top - stageTop : null;
      };
      const oldTops = tops(ghost, ".memo-content");
      const newTops = tops(target, ".memo-content");
      const oldMediaTop = boxTop(ghost, ".memo-images");
      const newMediaTop = boxTop(target, ".memo-images");
      if (plan.prev.editing) headerEl = target.querySelector(".memo-head");

      const clones = overlay ? ([...overlay.children] as HTMLElement[]) : [];
      let addOrder = 0;
      plan.ops.forEach((op, index) => {
        const el = clones[index];
        if (!el) return;
        if (op.type === "del") {
          const y = oldTops[op.oldIndex];
          if (y === undefined) return;
          cloneTracks.push({
            el,
            keyframes: [
              { transform: `translateY(${y}px)`, opacity: 1, clipPath: "inset(-2px 0px -2px 0px)" },
              { transform: `translateY(${y + 1}px)`, opacity: 1, clipPath: "inset(-2px 0px -2px 0px)", offset: 0.22 },
              { transform: `translateY(${y + 4}px)`, opacity: 0, clipPath: "inset(48% 0px 52% 0px)" }
            ],
            options: { duration: 180, delay: 30, easing: EASE, fill: "both" }
          });
        } else if (op.type === "keep") {
          const from = oldTops[op.oldIndex];
          const to = newTops[op.newIndex];
          if (from === undefined || to === undefined) return;
          cloneTracks.push({
            el,
            keyframes: [
              { transform: `translateY(${from}px)`, opacity: 1 },
              { transform: `translateY(${to}px)`, opacity: 1 }
            ],
            options: { duration: 220, delay: 40, easing: EASE_OUT, fill: "both" }
          });
        } else {
          const to = newTops[op.newIndex];
          if (to === undefined) return;
          cloneTracks.push({
            el,
            keyframes: [
              { transform: `translateY(${to + 8}px)`, opacity: 0, clipPath: "inset(28% 0px 28% 0px)" },
              { transform: `translateY(${to}px)`, opacity: 1, clipPath: "inset(-2px 0px -2px 0px)" }
            ],
            options: { duration: 180, delay: 70 + Math.min(addOrder, 5) * 8, easing: EASE_OUT, fill: "both" }
          });
          addOrder += 1;
        }
      });

      for (const el of clones.slice(plan.ops.length)) {
        if (el.classList.contains("is-media-kept") && oldMediaTop !== null && newMediaTop !== null) {
          cloneTracks.push({
            el,
            keyframes: [
              { transform: `translateY(${oldMediaTop}px)`, opacity: 1 },
              { transform: `translateY(${newMediaTop}px)`, opacity: 1 }
            ],
            options: { duration: 220, delay: 40, easing: EASE_OUT, fill: "both" }
          });
        } else if (el.classList.contains("is-media-old") && oldMediaTop !== null) {
          cloneTracks.push({
            el,
            keyframes: [
              { transform: `translateY(${oldMediaTop}px) scale(1)`, opacity: 1 },
              { transform: `translateY(${oldMediaTop + 3}px) scale(0.99)`, opacity: 0 }
            ],
            options: { duration: 170, delay: 35, easing: EASE, fill: "both" }
          });
        } else if (el.classList.contains("is-media-new") && newMediaTop !== null) {
          cloneTracks.push({
            el,
            keyframes: [
              { transform: `translateY(${newMediaTop + 10}px)`, opacity: 0 },
              { transform: `translateY(${newMediaTop}px)`, opacity: 1 }
            ],
            options: { duration: 190, delay: 80, easing: EASE_OUT, fill: "both" }
          });
        }
      }
    }

    // ---- Writes: pin the height, then launch every track. ----
    for (const anim of animsRef.current) anim.cancel();
    animsRef.current = [];
    const anims = animsRef.current;

    stage.style.height = `${h0}px`;
    anims.push(
      stage.animate([{ height: `${h0}px` }, { height: `${h1}px` }], {
        duration: plan.kind === "replay" ? REPLAY_HEIGHT_MS : SWAP_HEIGHT_MS,
        easing: EASE_OUT,
        fill: "both"
      })
    );
    anims.push(
      outgoing.animate(
        [
          { opacity: 1, transform: "translateY(0)" },
          { opacity: 0, transform: plan.kind === "toEdit" ? "translateY(0)" : "translateY(-5px)" }
        ],
        { duration: plan.kind === "replay" ? 130 : 120, easing: EASE, fill: "both" }
      )
    );
    if (plan.kind === "toEdit" || plan.kind === "swap") {
      anims.push(
        target.animate(
          [
            { opacity: 0, transform: `translateY(${plan.kind === "toEdit" ? 6 : 4}px)` },
            { opacity: 1, transform: "translateY(0)" }
          ],
          { duration: 180, delay: 25, easing: EASE_OUT, fill: "both" }
        )
      );
    }
    if (headerEl) {
      anims.push(headerEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, delay: 25, easing: EASE, fill: "both" }));
    }
    for (const track of cloneTracks) anims.push(track.el.animate(track.keyframes, track.options));

    // Settle when every track lands — with a hard deadline as insurance: if
    // a finished promise never resolves (devtools animation pausing, a
    // stalled timeline), the stage must not stay pinned forever. The
    // plan-identity guard makes whichever fires second a no-op.
    const settle = () => {
      if (morphRef.current === plan) setMorph(null);
    };
    Promise.allSettled(anims.map((anim) => anim.finished)).then(settle);
    const deadline = window.setTimeout(settle, (plan.kind === "replay" ? 340 : SWAP_HEIGHT_MS) + 260);
    return () => window.clearTimeout(deadline);
  }, [morph]);

  useEffect(
    () => () => {
      for (const anim of animsRef.current) anim.cancel();
      animsRef.current = [];
    },
    []
  );

  const viewMounted = morph ? true : !snap.editing;
  const editMounted = snap.editing || (morph !== null && morph.prev.editing);
  const ghostMounted = morph !== null && morph.kind !== "toEdit" && (morph.kind === "replay" || !morph.prev.editing);
  const ghostIsOut = ghostMounted && !morph!.prev.editing;

  const viewClass = `stage-scene is-view${morph?.kind === "toEdit" ? " is-out" : ""}${morph?.kind === "replay" ? " stage-hold" : ""}`;
  const editClass = `stage-scene is-edit${morph && morph.kind !== "toEdit" && morph.prev.editing ? " is-out" : ""}`;
  const ghostClass = `stage-scene stage-ghost${ghostIsOut ? " is-out" : ""}`;

  const replay = morph?.kind === "replay" ? morph : null;
  const mediaKept = replay !== null && replay.prev.mediaKey === snap.mediaKey && snap.mediaKey !== "";

  return (
    <div className={`card-stage${morph ? " is-morphing" : ""}`} ref={stageRef}>
      {viewMounted ? (
        <div key="view" className={viewClass} ref={viewRef}>
          {view}
        </div>
      ) : null}
      {editMounted ? (
        <div key="edit" className={editClass} ref={editRef}>
          {snap.editing ? editor : editorHeldRef.current}
        </div>
      ) : null}
      {ghostMounted ? (
        <div key="ghost" className={ghostClass} ref={ghostRef} aria-hidden="true">
          {renderGhost(morph!.prev.content, morph!.prev.images)}
        </div>
      ) : null}
      {replay ? (
        <div key="overlay" className="stage-overlay" ref={overlayRef} aria-hidden="true">
          {replay.ops!.map((op, index) => {
            // The line below this one in the text this row belongs to (old
            // text for del rows, new text for keep/add) — MemoLine uses it
            // to keep table-header bolding identical in the clone.
            const below = replay
              .ops!.slice(index + 1)
              .find((next) => (op.type === "del" ? next.type !== "add" : next.type !== "del"))?.raw;
            return (
              <div key={index} className="memo-content stage-line">
                {renderLine(op.raw, below)}
              </div>
            );
          })}
          {mediaKept ? (
            <div className="stage-line is-media-kept">{renderGhostMedia(snap.content, snap.images)}</div>
          ) : (
            <>
              {replay.prev.mediaKey ? <div className="stage-line is-media-old">{renderGhostMedia(replay.prev.content, replay.prev.images)}</div> : null}
              {snap.mediaKey ? <div className="stage-line is-media-new">{renderGhostMedia(snap.content, snap.images)}</div> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
