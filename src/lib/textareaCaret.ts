// Where a character offset sits inside a <textarea>, in px from the
// textarea's border-box top-left (content coordinates — subtract scrollTop
// for what is on screen). Textareas expose no caret geometry, so a hidden
// mirror div with the same box and type metrics lays the text out up to the
// offset and a marker span reports where it landed.

const COPIED = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontFeatureSettings",
  "fontVariantNumeric",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textIndent",
  "textTransform",
  "tabSize",
  "whiteSpace",
  "overflowWrap",
  "wordBreak"
] as const;

export interface CaretPoint {
  top: number;
  left: number;
  /** One line box tall. */
  height: number;
}

export function caretPoint(area: HTMLTextAreaElement, offset: number): CaretPoint {
  const computed = window.getComputedStyle(area);
  const mirror = document.createElement("div");
  const style = mirror.style as unknown as Record<string, string>;
  for (const key of COPIED) style[key] = (computed as unknown as Record<string, string>)[key];
  // clientWidth excludes a scrollbar the textarea may be showing.
  if (area.clientWidth > 0) {
    style.boxSizing = "content-box";
    style.width = `${area.clientWidth - parseFloat(computed.paddingLeft) - parseFloat(computed.paddingRight)}px`;
    style.borderWidth = "0";
  }
  Object.assign(mirror.style, { position: "absolute", top: "0", left: "-9999px", visibility: "hidden", overflow: "hidden", height: "auto" });
  mirror.textContent = area.value.slice(0, offset);
  const marker = document.createElement("span");
  // The character after the caret (or a zero-width stand-in at the very end)
  // gives the marker a box to measure.
  marker.textContent = area.value.slice(offset, offset + 1) || "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.65 || 0;
  const border = area.clientWidth > 0 ? parseFloat(computed.borderTopWidth) || 0 : 0;
  const borderLeft = area.clientWidth > 0 ? parseFloat(computed.borderLeftWidth) || 0 : 0;
  const point = { top: marker.offsetTop + border, left: marker.offsetLeft + borderLeft, height: lineHeight };
  mirror.remove();
  return point;
}
