import type { Message } from "../bus/index.js";
import type { BeliefBase } from "./beliefs.js";

/**
 * A named computation an agent can perform over what it believes.
 *
 * The two halves of this library differ only in what they answer with:
 * {@link Proposition}s judge the world — `boolean`, does the condition hold? —
 * while an `Expression` answers with anything at all: a value it looked up, a
 * number it computed, a structure it assembled. The generic is the whole
 * difference between them; nothing else about the two concepts changes.
 *
 * An expression is inert until a directive names it. It declares a `name` so a
 * sender can refer to it across the bus without shipping code — the receiving
 * agent keeps the implementation, and the wire carries the name. The `evaluate`
 * body is where an ontology lives, in the application's terms.
 */
export interface Expression<T> {
  /** The name a sender uses to ask for this computation. */
  name: string;
  /**
   * Answers the expression given the agent's beliefs and the message that named
   * it.
   *
   * `beliefs` is the agent's own view of the world; `message` is everything the
   * sender furnished — its `content`, primarily, but also who sent it and how
   * the exchange is correlated, so the expression is never starved of context.
   * A condition is phrased against both: the sender supplies the particulars of
   * what it wants judged, the receiver the state it is judged against. A sender
   * with nothing to add passes a message whose intent lives entirely in the
   * expression name.
   *
   * May be async. An evaluation is at liberty to consult the outside world — a
   * service, a model — and judging by a belief lookup is only the common case,
   * not a bound on it. The library awaits either way, so a caller never
   * branches on how heavy the answer is.
   */
  evaluate(beliefs: BeliefBase, message: Message): T | Promise<T>;
}

/**
 * An expression that judges the world: it answers whether a condition holds,
 * given the agent's beliefs and the content of the message that named it.
 *
 * The one kind of expression the wire can carry the intent of. A condition φ in
 * FIPA's `request-when` is judged against the receiver's own state — the thing
 * the sender cannot see — so the receiver is the one that must own the code,
 * and the sender names it. The message that names it can still carry what the
 * condition ranges over, so the required information is never the receiver's to
 * guess.
 */
export type Proposition = Expression<boolean>;

/**
 * A registry of named computations, regardless of what they return.
 *
 * One agent owns one library, and its expressions answer with booleans,
 * numbers, values and structures alike, so `register` asks nothing of the
 * result type — an `Expression<number>` and an `Expression<boolean>` sit side
 * by side. `evaluate` therefore returns `unknown` here, and the caller narrows
 * it, usually to the type a plan body expects.
 *
 * Parameterise — `new ExpressionLibrary<string>()` — to keep this particular
 * library's own `evaluate` typed instead; the class shadows the result type
 * and otherwise behaves identically.
 */
export class ExpressionLibrary<T = unknown> {
  private readonly items = new Map<string, Expression<T>>();

  /**
   * Registers an expression under its name. A later registration with the same
   * name replaces the earlier one, which is how a plan overrides how a name is
   * answered.
   */
  register(expression: Expression<T>): void {
    this.items.set(expression.name, expression);
  }

  /** Whether an expression exists under this name. */
  has(name: string): boolean {
    return this.items.has(name);
  }

  /**
   * Evaluates the named expression given these beliefs and the naming message,
   * or `undefined` when no expression of that name is registered. Not
   * registering a name and registering one that says no are deliberately
   * different answers: the first is "this agent does not know that condition",
   * the second "here is what it believes".
   *
   * Resolves with the answer whatever the expression body is — a sync body and
   * an async one both settle here, so callers await once and no more.
   * `undefined` resolves when the name is unknown, and is never a registered
   * body's answer.
   */
  async evaluate(
    name: string,
    beliefs: BeliefBase,
    message: Message,
  ): Promise<T | undefined> {
    const expression = this.items.get(name);
    return expression ? expression.evaluate(beliefs, message) : undefined;
  }

  /** Every registered expression, in registration order. */
  all(): Expression<T>[] {
    return [...this.items.values()];
  }
}

/**
 * A registry of the conditions — the propositions — an agent can honour.
 *
 * The proposition library is exactly the expression library narrowed to
 * booleans: registering a {@link Proposition} and evaluating it by name against
 * the agent's beliefs is what lets a directive carry a condition the *sender*
 * names and the *receiver* judges.
 */
export class PropositionLibrary extends ExpressionLibrary<boolean> {}
