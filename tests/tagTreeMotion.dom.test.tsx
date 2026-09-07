// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TagTree } from '../src/components/TagTree';
import { LanguageProvider } from '../src/lib/i18n';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('keeps the painted position when a reorder is interrupted by another render', () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  const running = new Map<Element, { id: string; cancel: () => void }>();
  const offsets = new Map<Element, number>();
  const tracks: { name: string; frames: Keyframe[] }[] = [];
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const top = this.hasAttribute('data-flip') ? Array.from(this.parentElement!.children).indexOf(this) * 100 + (offsets.get(this) ?? 0) : 0;
    return { top, height: 100, width: 100, left: 0 } as DOMRect;
  });
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: function () { return running.has(this) ? [running.get(this)] : []; } });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: function (frames: Keyframe[], options: KeyframeAnimationOptions) {
    tracks.push({ name: this.dataset.flip, frames });
    const anim = { id: options.id, cancel: () => { running.delete(this); offsets.delete(this); } };
    running.set(this, anim);
    return anim;
  } });
  const ui = (names: string[]) => <LanguageProvider><TagTree tree={names.map(name => ({ name, path: name, count: 1, children: [] }))} activeTag={null} pinnedTags={new Map()} onPickTag={() => {}} onPinTag={() => {}} onRenameTag={() => {}} onRemoveTag={() => {}} /></LanguageProvider>;
  const view = render(ui(['a', 'b']));
  view.rerender(ui(['b', 'a']));
  const row = view.container.querySelector('[data-flip="a"]')!;
  offsets.set(row, -50);
  view.rerender(ui(['b', 'a']));
  expect(tracks.filter(t => t.name === 'a').at(-1)!.frames[0]).toEqual({ transform: 'translateY(-50px)' });
});
