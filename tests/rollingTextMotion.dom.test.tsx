// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RollingText } from '../src/components/RollingText';
vi.mock('../src/lib/i18n', () => ({ useI18n: () => ({ formatNumber: String }) }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('sizes compact columns from their destination and staggers digits without counting punctuation', () => {
  vi.useFakeTimers();
  const view = render(<RollingText value={444} text="444" />);
  view.rerender(<RollingText value={21700} text="21.7" />);
  expect([...view.container.querySelectorAll('.roll-measure')].map(el => el.textContent)).toEqual(['2', '1', '.', '7']);
  expect([...view.container.querySelectorAll<HTMLElement>('.roll-slot')].map(el => el.style.getPropertyValue('--ri'))).toEqual(['2', '1', '1', '0']);
  expect(view.container.querySelectorAll('.roll-char-out')).toHaveLength(3);
  act(() => vi.advanceTimersByTime(300));
  expect(view.container.querySelectorAll('.roll-char-out')).toHaveLength(3);
  act(() => vi.advanceTimersByTime(300));
  expect(view.container.querySelectorAll('.roll-char-out')).toHaveLength(0);
});
it('keeps decreasing wheels and their cleanup intact after a rapid reversal', () => {
  vi.useFakeTimers();
  const view = render(<RollingText value={444} text="444" />);
  view.rerender(<RollingText value={21700} text="21.7" />);
  act(() => vi.advanceTimersByTime(200));
  view.rerender(<RollingText value={444} text="444" />);
  expect(view.container.querySelectorAll('.roll-char-in.is-down')).toHaveLength(3);
  act(() => vi.advanceTimersByTime(300));
  expect(view.container.querySelector('.roll-char-in.is-down')).not.toBeNull();
  act(() => vi.advanceTimersByTime(300));
  expect(view.container.querySelectorAll('.roll-slot')).toHaveLength(3);
  expect(view.container.querySelectorAll('.roll-char-out')).toHaveLength(0);
});
it('clears reduced-motion fade ghosts and roll flags on fade animationend without waiting for the fallback timer', () => {
  vi.useFakeTimers();
  const view = render(<RollingText value={10} />);
  view.rerender(<RollingText value={9} />);
  const outFaces = [...view.container.querySelectorAll<HTMLElement>('.roll-char-out')];
  const inFaces = [...view.container.querySelectorAll<HTMLElement>('.roll-char-in')];
  expect(outFaces).toHaveLength(2);
  expect(inFaces).toHaveLength(1);
  // Under prefers-reduced-motion: reduce, CSS swaps roll-char-* to fade-out / fade-in.
  const end = (el: HTMLElement, animationName: string) => {
    for (const type of ['animationend', 'webkitAnimationEnd']) {
      fireEvent(el, Object.assign(new Event(type, { bubbles: true }), { animationName }));
    }
  };
  for (const el of outFaces) end(el, 'fade-out');
  for (const el of inFaces) end(el, 'fade-in');
  expect(view.container.querySelectorAll('.roll-char-out')).toHaveLength(0);
  expect(view.container.querySelectorAll('.roll-char-in')).toHaveLength(0);
  // The collapsed tens slot is removed once its outgoing ghost finishes fading.
  expect(view.container.querySelectorAll('.roll-slot')).toHaveLength(1);
});
