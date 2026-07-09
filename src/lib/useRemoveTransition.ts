import { useCallback, useRef } from "react";

/**
 * Height-collapse removal: lock the element's current height, add
 * `.is-removing` (CSS transitions height/opacity/margins to zero), and only
 * then commit the removal so neighbours glide up instead of snapping.
 */
export function useRemoveTransition() {
  const pending = useRef(new Set<string>());

  return useCallback((element: HTMLElement | null, id: string, commit: () => void) => {
    if (!element || pending.current.has(id)) {
      commit();
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      commit();
      return;
    }
    pending.current.add(id);
    element.style.height = `${element.getBoundingClientRect().height}px`;
    // Force a reflow so the fixed height is the transition start point.
    void element.offsetHeight;
    element.classList.add("is-removing");
    element.style.height = "0px";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pending.current.delete(id);
      commit();
    };
    element.addEventListener("transitionend", (event) => {
      if (event.propertyName === "height") finish();
    });
    window.setTimeout(finish, 420);
  }, []);
}
