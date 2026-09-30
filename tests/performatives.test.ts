import { describe, expect, it } from "vitest";
import {
  canonicalPerformative,
  directivePriority,
  directsAction,
  FIPA_PERFORMATIVES,
  hasHearerEffect,
  isPropositional,
  LEGACY_PERFORMATIVES,
  PERFORMATIVE_CLASSES,
  performativeClass,
  performativeClasses,
} from "../src/bus/performatives.js";
import type {
  FIPAPerformative,
  Performative,
} from "../src/bus/performatives.js";

describe("FIPA-ACL performative vocabulary", () => {
  it("carries the whole FIPA-ACL 97 set", () => {
    expect([...FIPA_PERFORMATIVES].sort()).toEqual(
      [
        "accept-proposal",
        "agree",
        "cancel",
        "commit",
        "confirm",
        "declare",
        "delegate",
        "disagree",
        "disconfirm",
        "failure",
        "inform",
        "invite",
        "invoke",
        "promise",
        "propagate",
        "proxy",
        "query-if-known",
        "refuse",
        "reject-proposal",
        "request",
        "request-when",
        "request-whenever",
        "sorry",
        "subscribe",
        "unsubscribe",
      ].sort(),
    );
  });

  it("gives every performative an entry, so the table is the vocabulary", () => {
    expect(Object.keys(PERFORMATIVE_CLASSES).sort()).toEqual(
      [...FIPA_PERFORMATIVES].sort(),
    );
  });

  it("maps a performative to the class FIPA-ACL assigns it", () => {
    expect(performativeClass("inform")).toBe("assertive");
    expect(performativeClass("request")).toBe("directive");
    expect(performativeClass("declare")).toBe("declarative");
    expect(performativeClass("failure")).toBe("expressive");
    expect(performativeClass("accept-proposal")).toBe("commissive");
  });

  it("reports every class a context-dependent performative belongs to", () => {
    // `agree` asserts a proposition and also reports the speaker's state.
    expect(performativeClasses("agree")).toEqual(["assertive", "expressive"]);
    expect(performativeClasses("subscribe")).toEqual([
      "assertive",
      "directive",
    ]);
    expect(performativeClasses("cancel")).toEqual([
      "declarative",
      "expressive",
    ]);
  });

  it("leaves a performative the spec assigns no class unclassified", () => {
    expect(performativeClasses("invite")).toEqual([]);
    expect(performativeClass("invoke")).toBeUndefined();
    expect(performativeClasses("unsubscribe")).toEqual([]);
  });
});

describe("hasHearerEffect", () => {
  it("is true only for the directive class", () => {
    for (const performative of FIPA_PERFORMATIVES) {
      const expected = performativeClasses(performative).includes("directive");
      expect(hasHearerEffect(performative), performative).toBe(expected);
    }
  });

  it("is false for an assertion, which compels nothing", () => {
    // The distinction the whole design rests on: `inform` asserts a
    // proposition about the world and leaves the receiver free.
    expect(hasHearerEffect("inform")).toBe(false);
    expect(hasHearerEffect("confirm")).toBe(false);
    expect(hasHearerEffect("declare")).toBe(false);
  });

  it("is true for `subscribe`, which is a directive FIPA-ACL also reads as an assertion", () => {
    expect(hasHearerEffect("subscribe")).toBe(true);
  });
});

describe("isPropositional", () => {
  it("admits the assertives and declaratives", () => {
    for (const performative of [
      "inform",
      "confirm",
      "disagree",
      "disconfirm",
      "declare",
      "cancel",
      "query-if-known",
      "subscribe",
    ] satisfies Performative[]) {
      expect(isPropositional(performative), performative).toBe(true);
    }
  });

  it("refuses the performatives that are about the conversation, not the world", () => {
    // A directive is an instruction, an expressive reports the speaker's
    // state, a commissive is a promise. None of it is a fact to store.
    for (const performative of [
      "request",
      "delegate",
      "failure",
      "refuse",
      "reject-proposal",
      "sorry",
      "accept-proposal",
      "promise",
      "commit",
    ] satisfies Performative[]) {
      expect(isPropositional(performative), performative).toBe(false);
    }
  });

  it("admits the conditional directives, which assert as well as direct", () => {
    // `request-when` is both an assertion of its condition and a directive to
    // act on it, so it qualifies on both counts and `Agent` does both.
    expect(isPropositional("request-when")).toBe(true);
    expect(directsAction("request-when")).toBe(true);
    expect(isPropositional("request-whenever")).toBe(true);
  });

  it("refuses a performative the spec leaves unclassified", () => {
    for (const performative of [
      "invite",
      "invoke",
      "propagate",
      "proxy",
      "unsubscribe",
    ] satisfies Performative[]) {
      expect(isPropositional(performative), performative).toBe(false);
    }
  });
});

describe("directsAction", () => {
  it("is true for the directives that ask for an action to be performed", () => {
    for (const performative of [
      "request",
      "delegate",
      "request-when",
      "request-whenever",
      "achieve",
    ] satisfies Performative[]) {
      expect(directsAction(performative), performative).toBe(true);
    }
  });

  it("is false for `subscribe`, which asks to monitor rather than to act", () => {
    // A directive in FIPA-ACL's taxonomy, but the receiver is being asked to
    // watch a proposition. Turning it into a goal would have the receiver take
    // on work it was never asked to perform.
    expect(hasHearerEffect("subscribe")).toBe(true);
    expect(directsAction("subscribe")).toBe(false);
  });

  it("is false for the conversation-only performatives", () => {
    for (const performative of [
      "inform",
      "confirm",
      "declare",
      "failure",
      "refuse",
      "accept-proposal",
      "promise",
      "query-if-known",
    ] satisfies Performative[]) {
      expect(directsAction(performative), performative).toBe(false);
    }
  });
});

describe("legacy performatives", () => {
  it("canonicalises the two this library accepted before FIPA-ACL", () => {
    // `achieve` is KQML, `query` is `query-if-known` shortened.
    expect(canonicalPerformative("achieve")).toBe("request");
    expect(canonicalPerformative("query")).toBe("query-if-known");
  });

  it("leaves a canonical performative alone", () => {
    for (const performative of FIPA_PERFORMATIVES) {
      expect(canonicalPerformative(performative)).toBe(performative);
    }
  });

  it("classifies a legacy performative as its canonical form", () => {
    expect(performativeClasses("achieve")).toEqual(
      performativeClasses("request"),
    );
    expect(isPropositional("query")).toBe(true);
  });

  it("maps only to performatives that exist", () => {
    for (const target of Object.values(LEGACY_PERFORMATIVES)) {
      expect(FIPA_PERFORMATIVES).toContain(target);
    }
  });
});

describe("directivePriority", () => {
  it("weighs `achieve` above `request`, as it always has", () => {
    expect(directivePriority("request")).toBe(5);
    expect(directivePriority("achieve")).toBe(8);
  });

  it("weighs the remaining action directives like `request`", () => {
    for (const performative of [
      "delegate",
      "request-when",
      "request-whenever",
    ] satisfies Performative[]) {
      expect(directivePriority(performative), performative).toBe(5);
    }
  });

  it("is undefined for a performative that does not direct action", () => {
    for (const performative of [
      "inform",
      "subscribe",
      "failure",
      "declare",
      "promise",
    ] satisfies Performative[]) {
      expect(directivePriority(performative), performative).toBeUndefined();
    }
  });

  it("agrees with directsAction on which performatives have a priority", () => {
    const all = [...FIPA_PERFORMATIVES, "achieve", "query"] as Performative[];

    for (const performative of all) {
      const priority = directivePriority(performative);
      expect(priority !== undefined, performative).toBe(
        directsAction(performative),
      );
    }
  });
});
