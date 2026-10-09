/** Resolves after the browser has had a chance to paint (so a spinner or a disabled button shows before heavy work). */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 100); // rAF does not fire in background tabs
    requestAnimationFrame(() => setTimeout(() => { clearTimeout(timer); resolve(); }, 0));
  });
}
