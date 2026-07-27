// The documents the suites drive.
//
// One module per capability, with its signatures final (D-014). The fan-out
// milestones in Phase 5 add tests, never harness: an agent that needs to change
// something here has been scoped wrong, and the split is what makes that
// visible rather than a merge conflict nobody reads.

export const PLAN_V1 = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Migration plan</title>
<style>body{font-family:system-ui;max-width:760px;margin:40px auto;color:#1a202c}li{margin:6px 0}</style>
</head>
<body>
  <article>
    <h1>Database migration plan</h1>
    <ol id="steps">
      <li data-lucid-id="step-backfill">Backfill from the events table nightly</li>
      <li>Cut over reads to the new store</li>
      <li>Decommission the legacy table</li>
    </ol>
    <p id="note">This plan assumes zero downtime is required for the cutover.</p>
  </article>
</body>
</html>`;

export const PLAN_V2 = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Migration plan</title>
<style>body{font-family:system-ui;max-width:760px;margin:40px auto;color:#1a202c}li{margin:6px 0}</style>
</head>
<body>
  <article>
    <h1>Database migration plan (revised)</h1>
    <ol id="steps">
      <li data-lucid-id="step-backfill">Backfill from the events table in one batch</li>
      <li>Verify row counts match</li>
      <li>Cut over reads to the new store</li>
      <li>Decommission the legacy table</li>
    </ol>
    <p id="note">This plan assumes zero downtime is required for the cutover.</p>
  </article>
</body>
</html>`;
