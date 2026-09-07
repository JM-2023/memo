// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Heatmap } from '../src/components/Heatmap';
import { LanguageProvider } from '../src/lib/i18n';
import { TipProvider } from '../src/components/Tip';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('retargets an interrupted height change from its painted height', () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  let painted: number | null = null;
  const tracks: Keyframe[][] = [];
  const natural = (el: Element) => el.querySelector('.heat-current .is-year') ? 80 : 200;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return { height: this.className === 'heat-viewport' ? painted ?? natural(this) : 0, width: 0, top: 0, left: 0 } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () { return this.className === 'heat-viewport' ? painted ?? natural(this) : 0; });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: function (frames: Keyframe[]) {
    if (this.className === 'heat-viewport') { tracks.push(frames); painted = 140; }
    return { cancel: () => { painted = null; }, finished: new Promise(() => {}) };
  } });
  const ui = (period: 'month' | 'year') => <LanguageProvider><TipProvider><Heatmap period={period} countsByDay={new Map()} minDay="2026-01-01" activeDay={null} onPickDay={() => {}} /></TipProvider></LanguageProvider>;
  const view = render(ui('month'));
  view.rerender(ui('year'));
  view.rerender(ui('month'));
  expect(tracks).toHaveLength(2);
  expect(tracks[1]).toEqual([{ height: '140px' }, { height: '200px' }]);
  view.unmount();
  expect(painted).toBeNull();
});
