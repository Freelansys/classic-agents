/**
 * The FIPA-ACL 97 performative vocabulary, and the semantics each performative
 * carries.
 *
 * A performative is a *speech act*: it types what the sender is doing to the
 * conversation, not what the receiver must do. FIPA-ACL groups performatives
 * into communicative-act (CA) classes, and the class determines the only thing
 * a receiver may rely on — whether the message has a **hearer effect**:
 *
 * - **Assertive** — the sender asserts a proposition (`Bel(s, p)`). Effects on
 *   the hearer: *none*. `inform`, `confirm`, `disconfirm`, `agree`, `subscribe`.
 * - **Directive** — the sender wants the hearer to do something
 *   (`⟨h, do(a)⟩`). The one class with a compelled hearer effect. `request`,
 *   `delegate`, `request-when`, `request-whenever`.
 * - **Declarative** — the sender's utterance brings the proposition about
 *   (`declare`, `cancel`). The hearer does not act; the speaker has already
 *   changed the world and owes the change.
 * - **Expressive** — the sender reports a psychological state (`failure`,
 *   `refuse`, `sorry`, `reject-proposal`). No protocol effect either way.
 * - **Commissive** — the speaker commits to a future action (`accept-proposal`,
 *   `promise`, `commit`). A promise *to* the hearer, not a demand *of* it.
 *
 * The load-bearing consequence: **an assertion compels nothing.** An agent
 * receiving `inform` is under no obligation to store, believe, or act on it —
 * it decides. Only a directive obligates the receiver, and even then FIPA
 * allows `refuse` in reply. `Agent` keeps those two facts apart: assertions
 * become beliefs only when `reviseBeliefs` chooses to make them so, while
 * directives become goals.
 *
 * Classes follow FIPA-ACL 97 Table 1, where some performatives appear under
 * more than one class because the reading is context-dependent — `agree` is
 * both an assertion and an expression, `subscribe` is both an assertion and a
 * directive. `invite`, `invoke`, `propagate`, `proxy` and `unsubscribe` are
 * listed performatives with no CA class in the spec's tables, and are reported
 * here as unclassified; `Agent` treats them as non-propositional, which is the
 * conservative reading.
 *
 * @see {@link isPropositional} for what may become a belief, and
 * {@link directsAction} for what may become a goal.
 */

/** Communicative-act class of a performative, per FIPA-ACL 97 Table 1. */
export type CommunicativeActClass =
  "assertive" | "directive" | "declarative" | "expressive" | "commissive";

/**
 * Every FIPA-ACL performative, mapped to the classes it belongs to. An empty
 * list means the spec assigns it no CA class.
 */
export const PERFORMATIVE_CLASSES = {
  "accept-proposal": ["commissive"],
  agree: ["assertive", "expressive"],
  cancel: ["declarative", "expressive"],
  commit: ["commissive"],
  confirm: ["assertive"],
  declare: ["declarative"],
  delegate: ["directive"],
  disagree: ["assertive", "expressive"],
  disconfirm: ["assertive", "expressive"],
  failure: ["assertive", "expressive"],
  inform: ["assertive"],
  invite: [],
  invoke: [],
  promise: ["commissive"],
  propagate: [],
  proxy: [],
  "not-understood": ["assertive"],
  "query-if-known": ["assertive"],
  refuse: ["expressive"],
  "reject-proposal": ["expressive"],
  request: ["directive"],
  "request-when": ["assertive", "directive"],
  "request-whenever": ["assertive", "directive"],
  sorry: ["expressive"],
  subscribe: ["assertive", "directive"],
  unsubscribe: [],
} as const satisfies Record<string, readonly CommunicativeActClass[]>;

/** A performative from the FIPA-ACL 97 vocabulary. */
export type FIPAPerformative = keyof typeof PERFORMATIVE_CLASSES;

/** Every FIPA-ACL performative, in specification order. */
export const FIPA_PERFORMATIVES = Object.keys(
  PERFORMATIVE_CLASSES,
) as FIPAPerformative[];

/**
 * Performatives this library accepted before FIPA-ACL was adopted wholesale,
 * mapped to the FIPA performative they mean. Neither is in FIPA-ACL: `achieve`
 * is a KQML performative and `query` is FIPA's `query-if-known` under a
 * shorter name.
 *
 * Kept rather than removed so existing senders keep working, and so a
 * receiver can migrate by canonicalising. `achieve` remains more than a rename
 * in practice: `Agent` weighs it as a stronger directive than `request`, so it
 * still selects ahead of one.
 */
export const LEGACY_PERFORMATIVES = {
  /** KQML. Canonically {@link FIPAPerformative `request`}. */
  achieve: "request",
  /** Canonically {@link FIPAPerformative `query-if-known`}. */
  query: "query-if-known",
} as const satisfies Record<string, FIPAPerformative>;

/** A non-FIPA performative this library still accepts, for compatibility. */
export type LegacyPerformative = keyof typeof LEGACY_PERFORMATIVES;

/**
 * Any performative an agent may send or receive: the FIPA-ACL vocabulary, plus
 * the legacy aliases above.
 *
 * Receiving one of the legacy performatives is indistinguishable from
 * receiving its canonical form. Sending one is preserved so an existing
 * sender is not silently reinterpreted — use {@link canonicalPerformative} to
 * normalise before comparing.
 */
export type Performative = FIPAPerformative | LegacyPerformative;

/**
 * The FIPA performative a legacy performative means, or the performative
 * itself when it is already canonical.
 *
 * @example
 * ```ts
 * canonicalPerformative("achieve"); // "request"
 * canonicalPerformative("inform");  // "inform"
 * ```
 */
export function canonicalPerformative(
  performative: Performative,
): FIPAPerformative {
  return (
    LEGACY_PERFORMATIVES[performative as LegacyPerformative] ??
    (performative as FIPAPerformative)
  );
}

/**
 * Every class a performative belongs to, empty for a performative the spec
 * leaves unclassified.
 *
 * A legacy performative reports the classes of the FIPA performative it means,
 * so classifying by behaviour does not depend on which spelling arrived.
 */
export function performativeClasses(
  performative: Performative,
): readonly CommunicativeActClass[] {
  const canonical = canonicalPerformative(performative);
  const classes = PERFORMATIVE_CLASSES[canonical];
  return classes ?? [];
}

/**
 * The performative's primary class — the first the spec lists it under — or
 * `undefined` when unclassified. Legacy performatives report the class of
 * their canonical form.
 */
export function performativeClass(
  performative: Performative,
): CommunicativeActClass | undefined {
  return performativeClasses(performative)[0];
}

/**
 * Whether the message compels the receiver to act.
 *
 * True for exactly the directive class, which is the only one whose declared
 * effect is on the hearer (`⟨h, do(a)⟩`). False for an assertion: `inform` has
 * no hearer effect at all, so a receiver that treats one as a command has
 * invented an obligation FIPA does not grant.
 *
 * Note that `subscribe` is a directive in the CA taxonomy and still reports
 * `true` here — it asks the hearer to *monitor* a proposition, not to perform
 * an action. {@link directsAction} is the narrower question of what becomes a
 * goal.
 */
export function hasHearerEffect(performative: Performative): boolean {
  return performativeClasses(performative).includes("directive");
}

/**
 * Whether the message asserts something about the world, and so is a candidate
 * for the belief base.
 *
 * Assertive and declarative performatives carry a proposition: what the sender
 * holds to be true, or what their utterance brought about. Everything else is
 * about the conversation instead of the world — a directive is an instruction,
 * an expressive reports a state of the speaker, a commissive is a promise —
 * and none of it is a fact to store.
 *
 * This is eligibility, not obligation. An agent that accepts a propositional
 * message still decides, per its `middleware` chain, whether to believe it.
 *
 * @example
 * ```ts
 * isPropositional("inform"); // true
 * isPropositional("declare"); // true
 * isPropositional("request"); // false
 * isPropositional("failure"); // false
 * ```
 */
export function isPropositional(performative: Performative): boolean {
  return performativeClasses(performative).some(
    (ca) => ca === "assertive" || ca === "declarative",
  );
}

/**
 * The performatives whose receiver takes on work: the sender is asking for an
 * action to be performed, and the receiver answers by acquiring a goal.
 *
 * Narrower than {@link hasHearerEffect}, which is a statement about FIPA's
 * taxonomy. The two differ: a directive in FIPA's sense need not be a request
 * to do the thing itself. `subscribe` asks the receiver to monitor a
 * proposition, and `request-when` attaches a condition to an action, so neither
 * is work the receiver is being asked to perform. Folding either into a goal
 * would have the receiver silently take on work it was never asked to do, so
 * the difference is what {@link isUnsupportedDirective} is built from.
 */
const ACTION_DIRECTIVES: ReadonlySet<Performative> = new Set([
  "request",
  "delegate",
  "achieve",
]);

/**
 * Whether a message of this performative asks the receiver to perform an
 * action, and so should create a goal. Distinct from
 * {@link hasHearerEffect}, which describes the CA taxonomy instead of the
 * reaction this library takes.
 */
export function directsAction(performative: Performative): boolean {
  return ACTION_DIRECTIVES.has(performative);
}

/**
 * Whether this performative compels the receiver to act, but asks for something
 * this library does not turn into a goal — so a receiver must decline it rather
 * than silently treat it as a plain request.
 *
 * Derived from FIPA's own taxonomy rather than an enumeration, so it stays
 * correct as the vocabulary grows: a performative is a directive by CA class
 * ({@link hasHearerEffect}) and is not one whose receiver takes on work
 * ({@link directsAction}), and this is the difference.
 *
 * That difference is currently `request-when`, `request-whenever` and
 * `subscribe`, for reasons that are not interchangeable but fail the same way:
 *
 * - `request-when` is `⟨s, h | do(a) | p⟩`, and `p` is evaluated against the
 *   **receiver's** beliefs. The sender names the condition but cannot compute
 *   it, since it cannot see the state it would be computed against, so
 *   honouring one needs a condition representation travelling as data. A JSON
 *   message content cannot carry a predicate, and running the action
 *   unconditionally would be the opposite of what was asked.
 * - `subscribe` asks the receiver to *monitor* a proposition and report when it
 *   changes. This library has no monitor: `Agent.subscribe` is an outbound topic
 *   subscription, not a standing obligation to watch a proposition on someone
 *   else's behalf.
 *
 * FIPA grants the hearer of a directive the right to refuse, and `Agent` takes
 * it — answering `refuse` with `reason: "unsupported"` rather than doing
 * something the sender did not ask for. An agent that can honour one of these,
 * with a condition language or a proposition monitor, extends `Agent` to say so.
 */
export function isUnsupportedDirective(performative: Performative): boolean {
  return hasHearerEffect(performative) && !directsAction(performative);
}

/**
 * Goal priority for a directive performative, `undefined` for one that does
 * not direct action.
 *
 * `achieve` outranks `request`: it predates the FIPA adoption and is
 * consistently weighed as the stronger "make this true" directive, so
 * existing senders keep their ordering.
 */
export function directivePriority(
  performative: Performative,
): number | undefined {
  switch (performative) {
    case "request":
      return 5;
    case "achieve":
      return 8;
    case "delegate":
      return 5;
    // The conditional directives are deliberately absent: carrying a priority
    // is a promise that a goal will be created, and these are refused instead.
    // A subclass that does evaluate the condition supplies its own ordering.
    default:
      return undefined;
  }
}
