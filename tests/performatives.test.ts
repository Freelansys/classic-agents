import { describe, expect, it } from "vitest";
import {
  directivePriority,
  directsAction,
  FIPA_PERFORMATIVES,
  hasHearerEffect,
  isPropositional,
  isUnsupportedDirective,
  PERFORMATIVE_CLASSES,
  performativeClass,
  performativeClasses,
} from "../src/bus/performatives.js";
import type { Performative } from "../src/bus/performatives.js";

/** Every name this library used to accept outside the FIPA vocabulary. */
const NON_FIPA_NAMES = [
  "achieve",
  "query",
  "commit",
  "declare",
  "delegate",
  "disagree",
  "invite",
  "invoke",
  "promise",
  "query-if-known",
  "sorry",
  "unsubscribe",
] as const;

describe("FIPA-ACL performative vocabulary", () => {
  it("carries the whole FIPA CAL set and nothing else", () => {
    // SC00037J §3, in the order the spec gives them. Nothing non-FIPA: the
    // vocabulary was cut back to these 22, so a name outside is not a slower
    // message, it is not a message.
    expect([...FIPA_PERFORMATIVES].sort()).toEqual([
      "accept-proposal",
      "agree",
      "cancel",
      "cfp",
      "confirm",
      "disconfirm",
      "failure",
      "inform",
      "inform-if",
      "inform-ref",
      "not-understood",
      "propagate",
      "propose",
      "proxy",
      "query-if",
      "query-ref",
      "refuse",
      "reject-proposal",
      "request",
      "request-when",
      "request-whenever",
      "subscribe",
    ]);
  });

  it("lists them in specification order, so FIPA_PERFORMATIVES is the spec's own list", () => {
    expect(FIPA_PERFORMATIVES).toEqual([
      "accept-proposal",
      "agree",
      "cancel",
      "cfp",
      "confirm",
      "disconfirm",
      "failure",
      "inform",
      "inform-if",
      "inform-ref",
      "not-understood",
      "propagate",
      "propose",
      "proxy",
      "query-if",
      "query-ref",
      "refuse",
      "reject-proposal",
      "request",
      "request-when",
      "request-whenever",
      "subscribe",
    ]);
  });

  it("gives every performative an entry, so the table is the vocabulary", () => {
    expect(Object.keys(PERFORMATIVE_CLASSES).sort()).toEqual(
      [...FIPA_PERFORMATIVES].sort(),
    );
  });

  it("maps a performative to the class FIPA assigns it", () => {
    expect(performativeClass("inform")).toBe("assertive");
    expect(performativeClass("inform-if")).toBe("assertive");
    expect(performativeClass("inform-ref")).toBe("assertive");
    expect(performativeClass("request")).toBe("directive");
    expect(performativeClass("cfp")).toBe("directive");
    expect(performativeClass("cancel")).toBe("declarative");
    expect(performativeClass("failure")).toBe("assertive");
    expect(performativeClass("accept-proposal")).toBe("commissive");
    expect(performativeClass("propose")).toBe("commissive");
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
    expect(performativeClasses("failure")).toEqual(["assertive", "expressive"]);
  });

  it("leaves a performative the spec assigns no class unclassified", () => {
    expect(performativeClasses("propagate")).toEqual([]);
    expect(performativeClass("proxy")).toBeUndefined();
  });
});

describe("names outside the vocabulary", () => {
  // A message arrives off the wire as a string, not as a `Performative`, so
  // the classification helpers have to survive every name this library no
  // longer knows — the ones it used to accept above all.
  it("classifies nothing, so an unrecognised act cannot become state or work", () => {
    for (const name of NON_FIPA_NAMES) {
      expect(performativeClasses(name as Performative), name).toEqual([]);
      expect(performativeClass(name as Performative), name).toBeUndefined();
      expect(isPropositional(name as Performative), name).toBe(false);
      expect(hasHearerEffect(name as Performative), name).toBe(false);
      expect(directsAction(name as Performative), name).toBe(false);
      expect(isUnsupportedDirective(name as Performative), name).toBe(false);
      expect(directivePriority(name as Performative), name).toBeUndefined();
    }
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
    expect(hasHearerEffect("inform-if")).toBe(false);
  });

  it("is true for `subscribe`, which is a directive FIPA also reads as an assertion", () => {
    expect(hasHearerEffect("subscribe")).toBe(true);
  });
});

describe("isPropositional", () => {
  it("admits the assertives and declaratives", () => {
    for (const performative of [
      "inform",
      "confirm",
      "disconfirm",
      "inform-if",
      "inform-ref",
      "cancel",
      "subscribe",
      "failure",
      "not-understood",
    ] satisfies Performative[]) {
      expect(isPropositional(performative), performative).toBe(true);
    }
  });

  it("refuses the performatives that are about the conversation, not the world", () => {
    // A directive is an instruction, an expressive reports the speaker's
    // state, a commissive is a promise. None of it is a fact to store.
    for (const performative of [
      "request",
      "cfp",
      "refuse",
      "reject-proposal",
      "accept-proposal",
      "propose",
    ] satisfies Performative[]) {
      expect(isPropositional(performative), performative).toBe(false);
    }
  });

  it("keeps the asserted half of a conditional directive", () => {
    // `request-when` asserts its condition as well as directing an action, and
    // the assertion still counts: the condition is a proposition about the
    // world, so it is offered to the belief base on its own terms.
    expect(isPropositional("request-when")).toBe(true);
    expect(isPropositional("request-whenever")).toBe(true);
  });

  it("refuses a performative the spec leaves unclassified", () => {
    for (const performative of [
      "propagate",
      "proxy",
    ] satisfies Performative[]) {
      expect(isPropositional(performative), performative).toBe(false);
    }
  });
});

describe("isUnsupportedDirective", () => {
  it("is true for exactly the directives whose receiver takes on no work", () => {
    // The point of deriving this from the CA class rather than listing names is
    // that it cannot go stale. So check the partition over the whole vocabulary:
    // a directive is either one this library turns into a goal, or one the
    // receiver must decline, and there is no third thing that slips through
    // `reviseBeliefs` to do nothing at all.
    for (const performative of FIPA_PERFORMATIVES) {
      const unsupported = isUnsupportedDirective(performative);
      expect(
        unsupported,
        `${performative}: ${directsAction(performative) ? "action" : hasHearerEffect(performative) ? "unsupported" : "neither"}`,
      ).toBe(hasHearerEffect(performative) && !directsAction(performative));
    }
  });

  it("is false for everything that is not a directive", () => {
    // An assertion the agent may decline to *believe* is a policy question, not
    // an unsupported performative: the agent does understand `inform`.
    for (const performative of FIPA_PERFORMATIVES) {
      if (!hasHearerEffect(performative)) {
        expect(isUnsupportedDirective(performative), performative).toBe(false);
      }
    }
  });

  it("names the performatives the base agent declines", () => {
    // A readable snapshot, so adding a performative that lands in this set is a
    // visible diff rather than a silent new refusal.
    expect(FIPA_PERFORMATIVES.filter(isUnsupportedDirective).sort()).toEqual([
      "cfp",
      "request-when",
      "request-whenever",
      "subscribe",
    ]);
  });
});

describe("directsAction", () => {
  it("is true for the directives that ask for an action to be performed", () => {
    for (const performative of [
      "request",
      "query-if",
      "query-ref",
    ] satisfies Performative[]) {
      expect(directsAction(performative), performative).toBe(true);
    }
  });

  it("is false for the directives that ask to monitor rather than to act", () => {
    // Both of these are directives in FIPA's taxonomy, and neither is work
    // the receiver is being asked to do: `request-when` makes the action
    // contingent on a condition, and `subscribe` asks the receiver to watch a
    // proposition. Turning either into a goal would have the receiver take on
    // work it was never asked to perform.
    for (const performative of [
      "request-when",
      "request-whenever",
      "subscribe",
    ] satisfies Performative[]) {
      expect(hasHearerEffect(performative), performative).toBe(true);
      expect(directsAction(performative), performative).toBe(false);
    }
  });

  it("treats `cfp` as a directive whose receiver must answer, not act", () => {
    // A `cfp` asks for a proposal inside a negotiation, not for the action
    // itself. Reading it as a request would be the one answer the sender did
    // not ask for, so it is declined instead.
    expect(hasHearerEffect("cfp")).toBe(true);
    expect(directsAction("cfp")).toBe(false);
    expect(isUnsupportedDirective("cfp")).toBe(true);
  });

  it("classifies query-if and query-ref as directives that direct action", () => {
    for (const performative of [
      "query-if",
      "query-ref",
    ] satisfies Performative[]) {
      expect(hasHearerEffect(performative), performative).toBe(true);
      expect(directsAction(performative), performative).toBe(true);
      expect(isUnsupportedDirective(performative), performative).toBe(false);
    }
  });

  it("is false for the conversation-only performatives", () => {
    for (const performative of [
      "inform",
      "confirm",
      "failure",
      "refuse",
      "accept-proposal",
      "propose",
    ] satisfies Performative[]) {
      expect(directsAction(performative), performative).toBe(false);
    }
  });
});

describe("directivePriority", () => {
  it("weighs every action directive the same", () => {
    // Each asks for one piece of work and carries no signal that one is more
    // urgent than another, so the sender's own ordering is the only ordering
    // there is.
    for (const performative of [
      "request",
      "query-if",
      "query-ref",
    ] satisfies Performative[]) {
      expect(directivePriority(performative), performative).toBe(5);
    }
  });

  it("gives the conditional directives no priority, since no goal follows", () => {
    // A priority is a promise that a goal will be created. These are refused,
    // so promising one would be a lie the sender could act on.
    for (const performative of [
      "request-when",
      "request-whenever",
    ] satisfies Performative[]) {
      expect(directivePriority(performative), performative).toBeUndefined();
    }
  });

  it("is undefined for a performative that does not direct action", () => {
    for (const performative of [
      "inform",
      "subscribe",
      "failure",
      "not-understood",
      "cfp",
      "propose",
    ] satisfies Performative[]) {
      expect(directivePriority(performative), performative).toBeUndefined();
    }
  });

  it("agrees with directsAction on which performatives have a priority", () => {
    for (const performative of FIPA_PERFORMATIVES) {
      const priority = directivePriority(performative);
      expect(priority !== undefined, performative).toBe(
        directsAction(performative),
      );
    }
  });
});
