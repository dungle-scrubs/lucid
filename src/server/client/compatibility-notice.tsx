import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CompatibilityDiagnostic } from "../../protocol/compatibility.js";

const empty: readonly CompatibilityDiagnostic[] = [];

export function useRuntimeCompatibility(
  request: (signal: AbortSignal) => Promise<Response>,
  enabled = true,
): readonly CompatibilityDiagnostic[] {
  const result = useQuery({
    enabled,
    queryFn: async ({ signal }) => {
      const response = await request(signal);
      if (!response.ok) throw new Error("Compatibility feedback is unavailable.");
      const data = (await response.json()) as {
        compatibility?: readonly CompatibilityDiagnostic[];
      };
      return data.compatibility ?? empty;
    },
    queryKey: ["runtime-compatibility"],
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Infinity,
  });
  return result.data ?? empty;
}

export function compatibilityKey(diagnostic: CompatibilityDiagnostic, selection = ""): string {
  return JSON.stringify([
    diagnostic.code,
    diagnostic.severity,
    diagnostic.origin,
    diagnostic.scope === "selection" ? selection : "",
    diagnostic.operation,
    diagnostic.hcn,
    diagnostic.harness,
  ]);
}

export function CompatibilityNotice(props: {
  readonly diagnostics: readonly CompatibilityDiagnostic[];
  readonly selection?: string;
}) {
  const { diagnostics, selection = "" } = props;
  const seen = useRef(new Set<string>());
  const [announcement, setAnnouncement] = useState("");
  const distinct = useMemo(
    () => [
      ...new Map(
        diagnostics.map((diagnostic) => [compatibilityKey(diagnostic, selection), diagnostic]),
      ).values(),
    ],
    [diagnostics, selection],
  );
  useEffect(() => {
    const messages: string[] = [];
    for (const diagnostic of diagnostics) {
      const key = compatibilityKey(diagnostic, selection);
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      messages.push(
        `${diagnostic.severity === "error" ? "Error" : "Warning"}: ${diagnostic.message}`,
      );
    }
    if (messages.length) setAnnouncement(messages.join(" "));
  }, [diagnostics, selection]);
  return (
    <>
      <p
        className="sr-only compatibility-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
      {distinct.length ? (
        <section className="compatibility-notices" aria-label="Agent compatibility">
          {distinct.map((diagnostic) => (
            <div
              className="compatibility-notice"
              data-severity={diagnostic.severity}
              key={compatibilityKey(diagnostic, selection)}
            >
              <p>
                <strong>{diagnostic.severity === "error" ? "Error" : "Warning"}.</strong>{" "}
                {diagnostic.message}
              </p>
              <p>{diagnostic.remedy}</p>
              <details>
                <summary>Installation details</summary>
                <dl>
                  <dt>Observed</dt>
                  <dd>
                    <time dateTime={diagnostic.observedAt}>{diagnostic.observedAt}</time>
                  </dd>
                  <dt>Executable</dt>
                  <dd>{diagnostic.hcn.path ?? "Unknown"}</dd>
                  <dt>Selected through</dt>
                  <dd>{diagnostic.hcn.source ?? "Unknown"}</dd>
                  {diagnostic.hcn.lookupRoot ? (
                    <>
                      <dt>Lookup folder</dt>
                      <dd>{diagnostic.hcn.lookupRoot}</dd>
                    </>
                  ) : null}
                  {diagnostic.harness ? (
                    <>
                      <dt>Harness</dt>
                      <dd>{diagnostic.harness.name ?? "Unknown"}</dd>
                      <dt>Harness executable</dt>
                      <dd>{diagnostic.harness.path ?? "Unknown"}</dd>
                    </>
                  ) : null}
                </dl>
              </details>
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}
