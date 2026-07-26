/**
 * DOM lookups that must resolve to the VISIBLE instance. Under the shell,
 * every open tab's view stays mounted (hidden with display:none) so composer
 * drafts and scroll positions survive switching - which means a bare
 * `document.querySelector` can land on a hidden twin. `offsetParent` is null
 * inside a display:none subtree, so the visible one is findable cheaply.
 */
export const visibleEl = <T extends HTMLElement>(selector: string): T | undefined =>
  Array.from(document.querySelectorAll<T>(selector)).find((el) => el.offsetParent !== null);
