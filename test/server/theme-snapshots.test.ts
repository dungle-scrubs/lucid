import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { instrumentArtifact } from "../../src/server/client/instrument.js";

test("real snapshots retain static adaptive graphics and preserve nonconforming script mutations", () => {
  for (const rewrite of [false, true]) {
    const html = `<!doctype html><html><head><meta name="lucid-theme" content="adaptive"><style>
      :root { --ink: #111; } @media(prefers-color-scheme:dark) { :root { --ink:#eee; } }
      </style></head><body><p>Content</p><input value="retained"><svg><circle fill="var(--ink)" /></svg>
      ${rewrite ? `<script>const query=matchMedia('(prefers-color-scheme: dark)');query.addEventListener('change',()=>document.querySelector('circle').setAttribute('fill',query.matches?'#eee':'#111'));</script>` : ""}
      </body></html>`;
    const result = spawnSync(
      process.execPath.includes("bun") ? "node" : process.execPath,
      ["test/helpers/theme-snapshots.mjs"],
      {
        encoding: "utf8",
        input: JSON.stringify({ equal: !rewrite, html: instrumentArtifact(html, "theme", 1) }),
      },
    );
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  }
});
