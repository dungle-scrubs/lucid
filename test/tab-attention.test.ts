import { describe, expect, test } from "bun:test";
import { attentionStateOf } from "../client/chrome/attention.ts";

/**
 * The tab badge's four-state precedence (plan 03, M3.1, D-018):
 * question > working > finished-unseen > settled. One state per tab,
 * resolved by rule - a tab never wears two badges, and the rule lives in a
 * pure function the strip merely renders.
 */

describe("attentionStateOf: precedence, one state per tab", () => {
  test("an open question outranks everything", () => {
    expect(attentionStateOf({ openQuestions: 2, working: true, unseen: true })).toBe("question");
  });

  test("working outranks unseen and settled", () => {
    expect(attentionStateOf({ openQuestions: 0, working: true, unseen: true })).toBe("working");
  });

  test("finished work the human has not looked at is finished-unseen", () => {
    expect(attentionStateOf({ openQuestions: 0, working: false, unseen: true })).toBe(
      "finished-unseen",
    );
  });

  test("nothing unseen and nothing owed is settled - approval carries no badge", () => {
    expect(attentionStateOf({ openQuestions: 0, working: false, unseen: false })).toBe("settled");
  });

  test("nothing at all is settled", () => {
    expect(attentionStateOf({ openQuestions: 0, working: false, unseen: false })).toBe("settled");
  });
});
