// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThinkingOrb } from '../src/components/ThinkingOrb';
import { paintDots } from '../src/lib/thinkingOrb';
vi.mock('../src/lib/thinkingOrb', async importOriginal => ({ ...await importOriginal<object>(), paintDots: vi.fn(), paintLines: vi.fn() }));
vi.mock('../src/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('starts a second morph at the exact last painted frame', () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  let now = 0;
  let frame: FrameRequestCallback = () => {};
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frame = fn; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform() {}, clearRect() {} } as never);
  const view = render(<ThinkingOrb state="working" />);
  view.rerender(<ThinkingOrb state="solving" />);
  now = 380;
  frame(now);
  const before = vi.mocked(paintDots).mock.calls.at(-1)!.slice(1);
  view.rerender(<ThinkingOrb state="breathing" />);
  const after = vi.mocked(paintDots).mock.calls.at(-1)!.slice(1);
  expect(after).toEqual(before);
  now = 1140;
  frame(now);
  expect(vi.mocked(paintDots).mock.calls.at(-1)!.slice(1)).not.toEqual(before);
});
