import { signBinary } from "../../scripts/sign-binary.js";

/** Compile a test binary the way `scripts/build.ts` does: `Bun.build`, then
 * an ad-hoc signature, since the compile API leaves the runtime's. */
export async function compileBinary(opts: {
  readonly entrypoint: string;
  readonly outfile: string;
  readonly plugins?: Bun.BunPlugin[];
}): Promise<string> {
  await Bun.build({
    compile: { autoloadBunfig: false, autoloadDotenv: false, outfile: opts.outfile },
    entrypoints: [opts.entrypoint],
    ...(opts.plugins ? { plugins: opts.plugins } : {}),
    throw: true,
  });
  signBinary(opts.outfile);
  return opts.outfile;
}
