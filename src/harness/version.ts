/**
 * The hcn version floor, and the comparison that enforces it.
 *
 * It lives in its own module because two layers need it and neither should
 * import the other: `node-deps.ts` checks the binary it resolved, and
 * `hcn-runner.ts` checks what the session stream reports about itself. Those
 * are different claims - a binary can print one version and speak an older
 * protocol - so both are checked.
 */

/** The release that shipped `hcn session --json` (RFC-01) and
 * `hcn session --effort` (RFC-12's last gap). */
export const HCN_MIN_VERSION = "0.6.0";

/** Numeric compare over major.minor.patch. A non-numeric part reads as 0,
 * so a prerelease suffix never makes a version look newer than it is. */
export const compareVersions = (a: string, b: string): number => {
  const parse = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/, "")
      .split(/[.\-+]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/** Whether a reported version is older than the surface lucid depends on. */
export const belowFloor = (found: string): boolean => compareVersions(found, HCN_MIN_VERSION) < 0;
