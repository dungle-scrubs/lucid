/** Ad-hoc sign a binary written by `Bun.build`'s compile API, on macOS.
 *
 * `bun build --compile` signs its macOS output. `Bun.build`'s compile API
 * does not, so the binary keeps the signature of the Bun runtime it was
 * appended to, and that signature no longer matches the bytes.
 *
 * On arm64 the kernel checks each code page against the signature when it
 * faults the page in, and sends SIGKILL on a mismatch: exit 137, no stderr,
 * crash reason `Code Signature Invalid`, indicator `Invalid Page`. Whether a
 * run faults a bad page depends on memory pressure, so an unsigned binary
 * can pass alone and die under load (issue #297). Agent harnesses run
 * `lucid` as a hook, so an unsigned build reads there as a broken hook.
 */
export function signBinary(path: string): void {
  if (process.platform !== "darwin") return;
  const sign = Bun.spawnSync(["codesign", "--force", "--sign", "-", path]);
  if (!sign.success) {
    throw new Error(
      `codesign failed on ${path}: ${sign.stderr.toString().trim()}\nAn unsigned arm64 binary is SIGKILLed on exec.`,
    );
  }
  const verify = Bun.spawnSync(["codesign", "--verify", "--strict", path]);
  if (!verify.success) {
    throw new Error(
      `${path} still carries an invalid signature after codesign: ${verify.stderr.toString().trim()}`,
    );
  }
}
