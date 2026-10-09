/**
 * The FIPA Communicative Act Library vocabulary — SC00037J, FIPA00037 — and the
 * semantics each performative carries.
 *
 * A performative is a *speech act*: it types what the sender is doing to the
 * conversation, not what the receiver must do.
 *
 * **The classes below are this library's, not FIPA's.** SC00037J defines each
 * act by a formal model (feasibility preconditions and a rational effect) and
 * does not sort the acts into classes; its "Table 1" is a table of the symbols
 * used in those models. The spec does borrow Searle's words informally — §5.4
 * calls `inform` an *assertive* and `request` a *directive* — and this library
 * extends that reading to every act, using Searle's five illocutionary classes
 * to decide how an `Agent` reacts. The assignments are the library's judgement.
 *
 * - **Assertive** — the sender asserts a proposition (`B_i p`). FIPA gives
 *   these a rational effect on the hearer: it comes to believe the content
 *   (`B_j p`; SC00037J §5.4.3 says so of "most of the assertives"). A rational
 *   effect is what the sender intends, not an obligation on the receiver.
 *   `confirm`, `disconfirm`, `failure`, `inform`, `inform-if`, `inform-ref`,
 *   `not-understood`, plus `agree`, `request-when`, `request-whenever` and
 *   `subscribe`, which SC00037J defines in terms of an `inform` of the
 *   sender's intention.
 * - **Directive** — the sender wants the hearer to do something
 *   (`⟨h, do(a)⟩`). The one class that asks the hearer to act. `cfp`,
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
 * The load-bearing consequence: **an assertion compels nothing.** FIPA's
 * rational effect for `inform` is that the receiver believes it, but a rational
 * effect is the sender's aim, not the receiver's duty: an agent receiving
 * `inform` is under no obligation to store, believe, or act on it — it decides,
 * under its trust chain. Only a directive asks the receiver to act, and even
 * then FIPA allows `refuse` in reply. `Agent` keeps those two facts apart: assertions
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
 * `propagate` and `proxy` are left unclassified here: they ask the receiver to
 * forward a message rather than to believe or do something of its own, and
 * none of the five classes fits. `Agent` treats them as non-propositional,
 * which is the conservative reading.
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

/**
 * Communicative-act class of a performative: Searle's five illocutionary
 * classes, as this library applies them. Not a FIPA classification.
 */
export type CommunicativeActClass =
  "assertive" | "directive" | "declarative" | "expressive" | "commissive";

/**
 * Every FIPA-ACL performative, in the order SC00037J §3 gives them, mapped to
 * the classes this library assigns it. An empty list means it is left
 * unclassified.
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
 * Whether the message asks the receiver to act.
 *
 * True for exactly the directive class, whose rational effect is something the
 * hearer does (`⟨h, do(a)⟩`). False for an assertion: its rational effect is
 * also on the hearer, but it is a belief (`B_j p`), not an action, so a
 * receiver that treats an `inform` as a command has invented an obligation
 * FIPA does not grant. (The name predates this wording: "hearer effect" here
 * means an effect the hearer is asked to bring about.)
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
 * to do the thing itself. `query-if` and `query-ref` are answered from the
 * receiver's knowledge rather than worked, and `subscribe` asks the receiver to
 * monitor a proposition, `request-when` attaches a condition to an action, and
 * `cfp` opens a negotiation — putting any of them in the goal queue would have
 * the receiver silently take on work it was never asked to perform. What
 * remains is a single act: today only `request`.
 */
const ACTION_DIRECTIVES: ReadonlySet<Performative> = new Set(["request"]);

/**
 * Whether a message of this performative asks the receiver to perform an
 * action, and so should create a goal. Distinct from
 * {@link hasHearerEffect}, which describes the CA taxonomy instead of the
 * reaction this library takes. Queries are the case the difference exists for:
 * they compel the hearer too, but {@link isQueryDirective} answers them
 * instead.
 */
export function directsAction(performative: Performative): boolean {
  return ACTION_DIRECTIVES.has(performative);
}

/**
 * The performatives whose receiver answers from its own knowledge instead of
 * taking on work: a directive that names a computation, not a job.
 *
 * Each maps one-to-one onto an {@link ExpressionLibrary} chosen at
 * construction: a `query-if` names a {@link Proposition} and is answered from
 * {@link PropositionLibrary}, a `query-ref` names an {@link Expression} and is
 * answered from {@link ExpressionLibrary} — evaluated by name against the
 * receiver's own beliefs and the message that asked. Neither creates a goal,
 * consumes a queue slot or needs a plan, which is what separates a query from
 * a request that happens to have a question-shaped answer.
 */
const QUERY_DIRECTIVES: ReadonlySet<Performative> = new Set([
  "query-if",
  "query-ref",
]);

/**
 * Whether the message is a directive the receiver answers by evaluating a
 * named proposition or expression, rather than one it takes on as work.
 */
export function isQueryDirective(performative: Performative): boolean {
  return QUERY_DIRECTIVES.has(performative);
}

/**
 * The directives that leave a **standing commitment** on the receiver: an
 * obligation that outlives the message and is discharged later, by watching a
 * named condition or value.
 *
 * - `request-when` — perform the action once the named {@link Proposition}
 *   holds. `⟨s, h | do(a) | p⟩`, with `p` judged against the receiver's own
 *   beliefs: the sender names it, the receiver owns its implementation.
 * - `request-whenever` — perform the action each time the proposition becomes
 *   true, until cancelled.
 * - `subscribe` — report the value of the named {@link Expression} now and each
 *   time it changes, until cancelled.
 *
 * Named propositions and expressions are what make these honourable: the wire
 * carries the name, never a predicate, and the receiver evaluates it.
 */
const STANDING_DIRECTIVES: ReadonlySet<Performative> = new Set([
  "request-when",
  "request-whenever",
  "subscribe",
]);

/**
 * Whether the message asks the receiver to take on a standing commitment —
 * watch a named proposition or expression on the sender's behalf — rather than
 * to act once or answer once.
 */
export function isStandingDirective(performative: Performative): boolean {
  return STANDING_DIRECTIVES.has(performative);
}

/**
 * Whether this performative compels the receiver to act, but asks for something
 * this library does not honour — so a receiver must decline it rather than
 * silently treat it as a plain request.
 *
 * Derived from FIPA's own taxonomy rather than an enumeration, so it stays
 * correct as the vocabulary grows: a performative is a directive by CA class
 * ({@link hasHearerEffect}) that is not taken on as work ({@link directsAction}),
 * answered from knowledge ({@link isQueryDirective}) or held as a standing
 * commitment ({@link isStandingDirective}).
 *
 * That leaves `cfp`. It opens a negotiation, and answering one means running a
 * protocol — matching a proposal against the call's parameter, keeping the
 * negotiation state the protocol's `:protocol` names — and this library holds
 * no such state. Reading a `cfp` as a request and scheduling the action would be
 * the one answer the sender did not ask for: it asked for a *proposal* about
 * the action, not the action.
 *
 * FIPA grants the hearer of a directive the right to refuse, and `Agent` takes
 * it — answering `refuse` with `verdict: "unsupported"` rather than doing
 * something the sender did not ask for. An agent that can negotiate extends
 * `Agent` to say so.
 */
export function isUnsupportedDirective(performative: Performative): boolean {
  return (
    hasHearerEffect(performative) &&
    !directsAction(performative) &&
    !isQueryDirective(performative) &&
    !isStandingDirective(performative)
  );
}

/**
 * Goal priority for a directive performative, `undefined` for one that does
 * not create a goal.
 *
 * `request` weighs 5 — one piece of work, no signal that it is more urgent than
 * another — and the sender's own ordering is the only ordering there is. The
 * switch is kept rather than collapsed into `directsAction ? 5 : undefined`
 * because per-performative weighting is the natural place for a future
 * distinction, and a future one should have to state itself here.
 */
export function directivePriority(
  performative: Performative,
): number | undefined {
  switch (performative) {
    case "request":
      return 5;
    // A conditional request creates the same goal a plain one does, only
    // later — when its proposition holds — so it weighs the same.
    case "request-when":
    case "request-whenever":
      return 5;
    // The queries, `subscribe` and the unsupported directives are deliberately
    // absent: carrying a priority is a promise that a goal will be created, and
    // a query or a subscription creates none — each is answered by evaluating —
    // while the unsupported ones are refused instead. A subclass that goals any
    // of them supplies its own ordering.
    default:
      return undefined;
  }
}
