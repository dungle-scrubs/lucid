/** Runs inside the opaque frame. Keep dependencies inside the function: its
 * source is injected into agent HTML, just like snapshot-dom helpers. */
export function installArtifactLinks(): (copy: Element) => void {
  const doc = document;
  const selector = "a[href], area[href]";
  const attributes = ["href", "target", "rel"] as const;
  type Attributes = Record<(typeof attributes)[number], string | null>;
  const originals = new WeakMap<Element, { applied: Attributes; original: Attributes }>();
  const read = (link: Element): Attributes => ({
    href: link.getAttribute("href"),
    rel: link.getAttribute("rel"),
    target: link.getAttribute("target"),
  });
  const normalize = (link: Element): void => {
    const current = read(link);
    const previous = originals.get(link);
    const original = previous ? { ...previous.original } : { ...current };
    if (previous) {
      for (const name of attributes) {
        if (current[name] !== previous.applied[name]) original[name] = current[name];
      }
    }
    const href = original.href?.trim() ?? "";
    const applied = { ...original };
    if (href.startsWith("#")) {
      applied.href = `about:srcdoc${href}`;
      applied.target = "_self";
    } else if (/^(https?:|\/\/)/i.test(href)) {
      applied.target = "_blank";
      applied.rel = [
        ...new Set(`${original.rel ?? ""} noopener noreferrer`.trim().split(/\s+/)),
      ].join(" ");
    }
    originals.set(link, { applied, original });
    for (const name of attributes) {
      if (current[name] === applied[name]) continue;
      const value = applied[name];
      if (value === null) link.removeAttribute(name);
      else link.setAttribute(name, value);
    }
  };
  const scan = (): void => {
    for (const link of doc.querySelectorAll(selector)) normalize(link);
  };
  scan();
  new MutationObserver(scan).observe(doc.documentElement, {
    attributeFilter: [...attributes],
    attributes: true,
    childList: true,
    subtree: true,
  });
  // Catch links inserted or changed and immediately activated, before the
  // mutation observer's microtask. Annotation's drag guard still runs.
  for (const event of ["click", "auxclick", "contextmenu"]) {
    doc.addEventListener(
      event,
      (input) => {
        const link = input.target instanceof Element ? input.target.closest(selector) : null;
        if (link) normalize(link);
      },
      true,
    );
  }
  return (copy: Element): void => {
    const live = doc.documentElement.querySelectorAll(selector);
    const cloned = copy.querySelectorAll(selector);
    for (let index = 0; index < live.length; index++) {
      const link = live[index];
      const target = cloned[index];
      const saved = link ? originals.get(link) : undefined;
      if (!target || !saved) continue;
      for (const name of attributes) {
        // Preserve an authored change that has not reached the observer yet.
        if (target.getAttribute(name) !== saved.applied[name]) continue;
        const value = saved.original[name];
        if (value === null) target.removeAttribute(name);
        else target.setAttribute(name, value);
      }
    }
  };
}

/** Popups have no opener and must not inherit the document's sandbox.
 * The document itself still has no same-origin or top-navigation grant. */
export const ARTIFACT_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";
