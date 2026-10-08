/**
 * The FIPA Communicative Act Library vocabulary — SC00037J, FIPA00037 — and the
 * semantics each performative carries.
 *
 * A performative is a *speech act*: it types what the sender is doing to the
 * conversation, not what the receiver must do. FIPA groups performatives into
 * communicative-act (CA) classes, and the class determines the only thing
 * a receiver may rely on — whether the message has a **hearer effect**:
 *
 * - **Assertive** — the sender asserts a proposition (`Bel(s, p)`). Effects on
 *   the hearer: *none*. `confirm`, `disconfirm`, `failure`, `inform`,
 *   `inform-if`, `inform-ref`, `not-understood`, plus the asserted half of
 *   `agree`, `request-when`, `request-whenever` and `subscribe`.
 * - **Directive** — the sender wants the hearer to do something
 *   (`⟨h, do(a)⟩`). The one class with a compelled hearer effect. `cfp`,
 *   `query-if`, `query-ref`, `request`, `request-when`, `request-whenever`,
 *   `subscribe`.
 * - **Declarative** — the sender's utterance brings the proposition about.
 *   The hearer does not act; the speaker has already changed the world and
 *   owes the change. `cancel`.
 * - **Expressive** — the sender reports a psychological state. No protocol
 *   effect either way. `refuse`, `reject-proposal`, plus the expressive half
 *   of `agree`, `cancel`, `disconfirm` and `failure`.
 * - **Commissive** — the speaker commits to a future action. A promise *to*
 *   the hearer, not a demand *of* it. `accept-proposal`, `propose`.
 *
 * The load-bearing consequence: **an assertion compels nothing.** An agent
 * receiving `inform` is under no obligation to store, believe, or act on it —
 * it decides. Only a directive obligates the receiver, and even then FIPA
 * allows `refuse` in reply. `Agent` keeps those two facts apart: assertions
 * become beliefs only when `reviseBeliefs` chooses to make them so, while
 * directives become goals.
 *
 * The vocabulary is exactly the 22 acts SC00037J §3 defines, listed in the
 * order the spec gives them. Nothing outside it is accepted: this library
 * once also carried `achieve` (a KQML act) and `query` as aliases, and a tail
 * of names no FIPA document defines — `commit`, `declare`, `delegate`,
 * `disagree`, `invite`, `invoke`, `promise`, `query-if-known`, `sorry`,
 * `unsubscribe`. All of them are gone, so a message that still uses one is
 * answered `not-understood` rather than reinterpreted.
 *
 * `propagate` and `proxy` are listed acts the spec's own tables leave without
 * a CA class, and are reported here as unclassified; `Agent` treats them as
 * non-propositional, which is the conservative reading.
 *
 * `inform-if` and `inform-ref` are **macro acts** in SC00037J's own words:
 * `⟨i, inform-if(j, φ)⟩ ≡ ⟨i, inform(j, φ)⟩ | ⟨i, inform(j, ¬φ)⟩`, and the
 * spec notes that "macro acts can be planned and requested, but not directly
 * performed." This library follows that literally: it never derives either as
 * a message it sends, and a received one is handled as the `inform` it
 * abbreviates — same class, same belief path, same state validation.
 *
 * @see {@link isPropositional} for what may become a belief, and
 * {@link directsAction} for what may become a goal.
 */

/** Communicative-act class of a performative. */
export type CommunicativeActClass =
  "assertive" | "directive" | "declarative" | "expressive" | "commissive";

/**
 * Every FIPA-ACL performative, mapped to the classes it belongs to, in the
 * order SC00037J §3 gives them. An empty list means the spec assigns it no CA
 * class.
 */
export const PERFORMATIVE_CLASSES = {
  "accept-proposal": ["commissive"],
  agree: ["assertive", "expressive"],
  cancel: ["declarative", "expressive"],
  cfp: ["directive"],
  confirm: ["assertive"],
  disconfirm: ["assertive", "expressive"],
  failure: ["assertive", "expressive"],
  inform: ["assertive"],
  "inform-if": ["assertive"],
  "inform-ref": ["assertive"],
  "not-understood": ["assertive"],
  propagate: [],
  propose: ["commissive"],
  proxy: [],
  "query-if": ["directive"],
  "query-ref": ["directive"],
  refuse: ["expressive"],
  "reject-proposal": ["expressive"],
  request: ["directive"],
  "request-when": ["assertive", "directive"],
  "request-whenever": ["assertive", "directive"],
  subscribe: ["assertive", "directive"],
} as const satisfies Record<string, readonly CommunicativeActClass[]>;

/** A performative from the FIPA-ACL vocabulary. */
export type FIPAPerformative = keyof typeof PERFORMATIVE_CLASSES;

/** Every FIPA-ACL performative, in specification order. */
export const FIPA_PERFORMATIVES = Object.keys(
  PERFORMATIVE_CLASSES,
) as FIPAPerformative[];

/**
 * Any performative an agent may send or receive: the FIPA-ACL vocabulary, and
 * nothing else. The name is kept because applications spell this type out in
 * their own signatures — but a name outside the vocabulary is not a slower
 * message, it is not a message.
 */
export type Performative = FIPAPerformative;

/**
 * Every class a performative belongs to, empty for a performative the spec
 * leaves unclassified.
 */
export function performativeClasses(
  performative: Performative,
): readonly CommunicativeActClass[] {
  return PERFORMATIVE_CLASSES[performative] ?? [];
}

/**
 * The performative's primary class — the first the spec lists it under — or
 * `undefined` when unclassified.
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
 * isPropositional("inform");     // true
 * isPropositional("inform-if");  // true
 * isPropositional("failure");    // true — assertive as well as expressive
 * isPropositional("request");    // false
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
 * proposition, `request-when` attaches a condition to an action, and `cfp`
 * opens a negotiation, so none of the three is work the receiver is being
 * asked to perform. Folding any of them into a goal would have the receiver
 * silently take on work it was never asked to do, so the difference is what
 * {@link isUnsupportedDirective} is built from.
 */
const ACTION_DIRECTIVES: ReadonlySet<Performative> = new Set([
  "request",
  "query-if",
  "query-ref",
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
 * That difference is currently `cfp`, `request-when`, `request-whenever` and
 * `subscribe`, for reasons that are not interchangeable but fail the same way:
 *
 * - `cfp` opens a negotiation. Answering one means running a protocol —
 *   matching a proposal against the call's parameter, keeping the negotiation
 *   state the protocol's `:protocol` names — and this library holds no such
 *   state. Reading a `cfp` as a request and scheduling the action would be
 *   the one answer the sender did not ask for: it asked for a *proposal* about
 *   the action, not the action.
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
 * it — answering `refuse` with `verdict: "unsupported"` rather than doing
 * something the sender did not ask for. An agent that can honour one of these,
 * with a condition language, a proposition monitor or a negotiation protocol,
 * extends `Agent` to say so.
 */
export function isUnsupportedDirective(performative: Performative): boolean {
  return hasHearerEffect(performative) && !directsAction(performative);
}

/**
 * Goal priority for a directive performative, `undefined` for one that does
 * not direct action.
 *
 * Every action directive weighs the same: `request`, `query-if` and `query-ref`
 * each ask for one piece of work and carry no signal that one is more urgent
 * than another, so the sender's own ordering is the only ordering there is.
 * The switch is kept rather than collapsed into `directsAction ? 5 : undefined`
 * because per-performative weighting is the natural place for a future
 * distinction, and a future one should have to state itself here.
 */
export function directivePriority(
  performative: Performative,
): number | undefined {
  switch (performative) {
    case "request":
      return 5;
    // `query-if` and `query-ref` are requests whose goal answers the question,
    // so they carry a goal name like `request` does and take the ordinary
    // admission path. They share `request`'s priority since they are equally
    // "please do this".
    case "query-if":
    case "query-ref":
      return 5;
    // The unsupported directives are deliberately absent: carrying a priority
    // is a promise that a goal will be created, and these are refused instead.
    // A subclass that does honour one supplies its own ordering.
    default:
      return undefined;
  }
}
