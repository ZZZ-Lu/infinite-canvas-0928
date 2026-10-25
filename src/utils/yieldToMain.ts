/** Let the browser paint and process input between bounded import steps. */
export function yieldToMain(): Promise<void> {
  if (typeof requestAnimationFrame === 'undefined') {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  return new Promise(resolve => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}
