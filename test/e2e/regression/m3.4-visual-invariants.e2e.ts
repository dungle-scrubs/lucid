import { expect, test } from "../harness.ts";
import { on } from "../locators.ts";
import {
  contrastRatio,
  fullyVisibleIn,
  isHittable,
  overlaps,
  scrollsSideways,
  settled,
} from "../visual.ts";

/**
 * M3.4 - the five visual instruments, read in both directions.
 *
 * Thirty suites are about to trust these, so the question this file answers is
 * not "does the chrome look right" but "does the instrument report correctly".
 * The first version asserted one direction each and passed with four of the
 * five replaced by constants - it tested the product and called that testing
 * the instrument.
 *
 * Every case below is a fixture built to have a KNOWN answer, so a helper
 * returning a constant fails at least one of them. The chrome is used only
 * where the truth is equally knowable there.
 */

/** A page with two boxes whose geometry is decided here, not by the product. */
const geometry = `<!doctype html>
<html><body style="margin:0;background:rgb(255,255,255)">
  <div id="a" style="position:absolute;left:0;top:0;width:100px;height:100px"></div>
  <div id="b" style="position:absolute;left:50px;top:50px;width:100px;height:100px"></div>
  <div id="far" style="position:absolute;left:400px;top:400px;width:10px;height:10px"></div>
  <div id="empty" style="position:absolute;left:0;top:0;width:0;height:0"></div>

  <div id="box" style="position:absolute;left:0;top:200px;width:100px;height:60px;overflow:auto">
    <div id="wide" style="width:500px;height:20px"></div>
    <div id="inside" style="width:20px;height:20px"></div>
  </div>
  <div id="clipped" style="position:absolute;left:200px;top:200px;width:100px;height:60px;overflow:hidden">
    <div style="width:500px;height:20px"></div>
  </div>

  <div id="dark" style="position:absolute;left:0;top:300px;background:rgb(0,0,0)">
    <span id="invisible" style="color:rgb(0,0,0)">cannot be read</span>
    <span id="legible" style="color:rgb(255,255,255)">can be read</span>
  </div>

  <button id="clickable" style="position:absolute;left:0;top:400px;width:80px;height:30px">ok</button>
  <button id="covered" style="position:absolute;left:100px;top:400px;width:80px;height:30px">no</button>
  <div style="position:absolute;left:100px;top:400px;width:80px;height:30px;background:rgba(0,0,0,0.01)"></div>
</body></html>`;

test("the instruments report correctly, in both directions", async ({ page, cli }) => {
  await cli.write(geometry);
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  const surface = page.frameLocator('iframe[title="artifact surface"]');
  await expect(surface.locator("#a")).toBeAttached();
  await settled(page);

  const el = (id: string) => surface.locator(`#${id}`);

  // OVERLAP - true, false, and the zero-area case that has no exceptions.
  expect(await overlaps(el("a"), el("b")), "boxes that intersect").toBe(true);
  expect(await overlaps(el("a"), el("far")), "boxes that do not").toBe(false);
  expect(await overlaps(el("empty"), el("empty")), "an element overlaps itself").toBe(true);

  // SIDEWAYS SCROLL - a real scroller reports its range; a clipped box reports
  // nothing, because it cannot be scrolled however far its content runs.
  expect(await scrollsSideways(el("box")), "an overflow:auto box with wide content").toBe(400);
  expect(await scrollsSideways(el("clipped")), "overflow:hidden is not scrollable").toBe(0);

  // CONTAINMENT - both axes. `wide` runs 400px past its container's right edge,
  // which a Y-only check called fully visible.
  expect(await fullyVisibleIn(el("inside"), el("box")), "a child that fits").toBe(true);
  expect(await fullyVisibleIn(el("wide"), el("box")), "a child that runs off sideways").toBe(false);

  // CONTRAST - the two extremes, against a known ground.
  expect(await contrastRatio(el("invisible")), "black on black").toBeLessThan(1.5);
  expect(await contrastRatio(el("legible")), "white on black").toBeGreaterThan(15);

  // HIT TEST - reachable, and covered by something the eye cannot see.
  expect(await isHittable(el("clickable")), "a button with nothing over it").toBe(true);
  expect(await isHittable(el("covered")), "a button under a near-invisible film").toBe(false);
});

test("the instruments agree with the real chrome", async ({ page, cli }) => {
  // The fixtures above prove the instruments; this proves they still read a
  // real page, where the answers are not arranged.
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  await settled(page);

  expect(await scrollsSideways(on(page).threadViewport())).toBe(0);
  expect(await isHittable(on(page).sendMessage())).toBe(true);
  const ratio = await contrastRatio(on(page).messageInput());
  expect(ratio, `composer text contrast is ${ratio.toFixed(2)}:1`).toBeGreaterThan(4.5);
});
