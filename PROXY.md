# Proxy: `proxy`

The plan for the `proxy` performative (DC00052, folded into SC00037J §3.14).
An agent can ask another agent to identify the agents described by a
descriptor and perform an embedded communicative act to each of them — to have
a message forwarded on its behalf. The receiver of the `proxy` does the
forwarding; it is not itself a target of the embedded act.

This is the last-but-one performative in the CAL vocabulary. `propagate` is the
sibling and is [not covered here](#not-covered): where `proxy` has the receiver
forward an act to *other* agents, `propagate` has the receiver treat the act as
sent to it *and* forward it onward. That difference is large enough to be its
own design.

[CONTRACT-NET.md](CONTRACT-NET.md) picks up the previous four acts.

**Status: not implemented, by decision.** The current release carries `proxy`
and `propagate` as directives (`PERFORMATIVE_CLASSES` in `performatives.ts`)
and stands with JADE and SPADE, neither of which implements forwarding: a
`proxy` or `propagate` is answered `refuse { verdict: "unsupported" }` by
`isUnsupportedDirective` rather than forwarded. Their rows in
[PERFORMATIVES.md](PERFORMATIVES.md) are **Done** as refusals, and
FIPA-COMPLIANCE.md issue 10 is **Fixed**. This document is the design for adding
real forwarding in a later release; the `refuse` is what buys the time to build
it.

## The act

```
sender i                              forwarder j                targets (Ref x)
    │ proxy { targets, message }             │                         │
    │   message = <i, cact> (no :receiver)   │                         │
    │ ─────────────────────────────────────▶ │                         │
    │      refuse { verdict, reason }        │  (or not-understood)    │
    │ ◀───────────────────────────────────── │                         │
    │      inform { forwarded, failed }      │  message                │
    │ ◀───────────────────────────────────── │ ──────────────────────▶ │
    │                                        │  :sender = j            │
    │                                        │  :receiver = target     │
    │                                        │  :reply-to = i          │
    │      the target's replies (recruiting)                           │
    │ ◀─────────────────────────────────────────────────────────────── │
```

- The **content** is a triple: a descriptor, the **embedded communicative act
  without a `:receiver`**, and an optional constraint `φ` (a hop limit, a count
  bound).
- On forwarding, FIPA fixes two rewrites: `:receiver` becomes the denoted
  agent, and `:sender` becomes **j**, the receiver of the `proxy`. The embedded
  act is performed *by* j, in j's name — that is what makes this an act of
  commissioning rather than relaying a forged message.
- FIPA defines two interaction protocols on top of the act. In **recruiting**
  (SC00034) the forwarded message keeps its `:reply-to`, so the target answers
  the original sender directly. In **brokering** (SC00033) the forwarder keeps
  the conversation's parameters and relays replies back. Only recruiting is
  stateless; brokering needs a live record in the forwarder (see
  [Not covered](#not-covered)).

`proxy` is a **directive**: its rational effect (`Done(<j, cact>)`) is that the
hearer acts. Its formal model defines it as an `inform` of the sender's
intention that j perform the act, with a feasibility precondition
`B_i B_i (Bif_j Uif_j)` — i must be competent about j's competence and
sincerity. This library reads the rational effect, as it does for every
directive, and honours it by default (D7).

## What the act is not: `propagate`

`propagate` (DC00050) is the sibling, and the difference decides the whole
design of each.

- **`proxy`** — j performs `cact` to the denoted agents. **j is not itself a
  recipient.** The sender sets `:sender` of the forward to j so the targets see
  a message from the broker, not from i.
- `propagate` — j treats the embedded message **as if sent directly to it**
  (j is a recipient) *and* forwards a copy. It is used to build a chain or tree
  across federated agents, with `hop-count`/`hop-limit` in the constraint. Its
  formal model is two acts: `<i, cact(j)>` followed by the same
  commissioning `proxy` does.

So `propagate` composes: it is "act on it yourself, then proxy it on". A
`propagate` plan would build on this one.

## Reference: JADE and SPADE

Neither framework implements the act, which is why the plan follows FIPA's own
model rather than a port.

- **JADE** carries `ACLMessage.PROXY` and `ACLMessage.PROPAGATE` as first-class
  performative constants, and its `OntologyServer` recognises them (it answers
  `FAILURE`/`REFUSE` for an incoming `PROXY` or `PROPAGATE` it cannot serve).
  But `jade.proto` ships behaviour classes for the request-like protocols
  only — request, query, contract-net, iterated contract-net, auctions,
  subscribe, propose. There is no broker or forwarder behaviour; JADE represents
  the act and leaves the forwarding to application code.
- **SPADE** carries the performative as a metadata string on an XMPP message and
  `FIPAMessage` checks it is a member of the FIPA set. It implements no act
  semantics at all, `proxy` included.

So there is no implementation to port. What both frameworks do agree on, and
what this library already does, is the envelope: `:sender`, `:receiver`,
`:reply-to`, `:conversation-id`, and a performative that is one of the 22 CAL
acts. The plan is FIPA's model expressed in this library's existing machinery.

## Reassessment: what the framework already provides

`proxy` needs little new on the forwarder. The two things it does — resolve a
name to agents, and send a message — are the bus's job already.

| Proxy needs | Already in place |
| --- | --- |
| Already a directive | `PERFORMATIVE_CLASSES.proxy = ["directive"]`; only `isUnsupportedDirective` stands between it and admission |
| A name the receiver resolves to agents | bus `topic` and explicit receiver ids, exactly as `CallRequest` uses for a `cfp` |
| Sending to a set of agents | `receiver` accepts a set and `sendMessageTo` fans it out, one exchange per receiver (FIPA-COMPLIANCE issue 12) |
| Sending in the agent's own name | `sendMessage` stamps `sender` and correlating ids; only absence is filled, so an embedded message's own ids survive |
| Not tracking an exchange whose replies go elsewhere | `sendMessage` tracks a directive only when its `reply-to` is unset or names this agent, so a recruited forward leaves no state on j |
| A consent gate before forwarding | `directiveMiddleware` through `considerDirective`, the same chain every honoured directive runs |
| A directive the receiver *answers* rather than *works* | `answerQuery` / `answerCfp`: the terminal step of `considerDirective` that sends an answer and creates no goal |
| Validating the embedded act | `envelopeViolationReason` and `isKnownPerformative` in `schemas.ts`, the checks every incoming message already passes |
| A protocol on every message | `protocolOf` / `openedProtocol`: the forward is stamped with its own act's protocol, the `proxy`'s replies echo the `proxy`'s |
| A reply the sender can read | the existing `inform` / `failure` / `refuse` / `not-understood` vocabulary |

**What is genuinely new** on the forwarder is small: a content schema, one
directive group, and one terminal handler that forwards and answers.

**What the first draft of this plan missed is the sender's side.** i sends a
`proxy`, but the replies that matter name an exchange i never sent itself: the
embedded act's `reply-with`, answered by targets i never addressed. Today every
such reply is unmatched. A target's final `inform { done: true }`, and j's
own `inform { forwarded, failed }`, would both be ingested as loose `msg.*`
beliefs — exactly the pollution FIPA-COMPLIANCE issue 5 removed for requests. So
the plan has two halves, like Contract Net: the forwarder, and the sender's
bookkeeping (D9).

The consequence worth stating: because forwarding is immediate bus work, not
long-running plan work, `proxy` behaves like a **query** — the receiver answers
it in the tick it is admitted — and **not** like a `request`, which becomes a
goal served by a plan. This is the central decision, D3.

## Decisions to agree

Record each in PERFORMATIVES.md before implementing. Each has a recommendation.

- **D1. Routing.** `proxy` is already a directive. *Recommend:* add a
  `FORWARD_DIRECTIVES` group with `isForwardDirective()`, beside
  `isCallForProposals`, and subtract it in `isUnsupportedDirective`, which then
  names `propagate` alone. Perception routes a forward directive to
  `considerDirective` like a query or a `cfp`.

- **D2. What the descriptor is.** FIPA's descriptor is a referential expression
  (`iota x δ(x)`, `any x δ(x)`, `all x δ(x)`) evaluated against a directory.
  This library's rule is that *the wire carries a name, and the receiver owns
  what is behind it* (the same rule that makes a `Plan.bid` a named expression
  and a query a named proposition). *Recommend:* reuse the two addressing forms
  a call already has — an explicit `receivers: string[]` or a `topic` string.
  An explicit list is fanned out with `sendMessageTo`; a topic is one
  `publishMessage`. *Alternative:* a registered named group the agent resolves
  through a resolver interface. That is more FIPA-faithful but adds a registry
  and an evaluation, and can come later behind the same `targets` field.

- **D3. Answered or worked.** *Recommend:* answered, like a query and a `cfp`.
  `answerProxy` runs after the middleware chain and sends the terminal reply
  directly; no goal is created, no queue slot is used, and no `agree` is sent.
  Forwarding is a bus send performed inside the tick, so there is no later work
  to defer and nothing for an `agree` to commit to. *Alternative:* admit a goal
  served by a plan, so the application controls forwarding. That puts protocol
  work in plan bodies and makes every agent that can forward need a plan for it,
  for an act whose whole content is already on the wire. (Unlike a `cfp`, which
  needs a plan's `bid` because only the application can price a job, a forward
  needs nothing the agent does not already have.)

- **D4. The forwarding rewrites.** *Recommend:* per FIPA — `:sender` = j, the
  `proxy`'s receiver; `:receiver` = the denoted target. Preserve the embedded
  message's own `:reply-to`, `:conversation-id`, `:reply-with` and `:reply-by`;
  `sendMessage` only fills absent values, so ids the embedded act already
  carries survive with no special handling. When the embedded act has **no**
  `:reply-to`, set it to the `proxy`'s sender (i), the recruiting reading, so a
  target's answer reaches the original requester. Because `sendMessage` does
  not track a directive whose replies go elsewhere, j keeps no state for it.
  *Alternative:* leave `:reply-to` unset, which forces every reply back through
  j and makes brokering mandatory — the stateful relay this plan declines to
  build.

  Every target of one `proxy` receives the **same** `:reply-with`, the one i
  chose (D9). Their replies are told apart by sender, as every per-exchange
  record already is (`intent.<peer>.<goal>.<exchange>`).

- **D5. Consent, safety and limits.** A forwarder is an open relay unless told
  otherwise, so the middleware gate is load-bearing. *Recommend:* the
  `directiveMiddleware` chain is the consent gate (a veto is
  `refuse { verdict: "middleware" }`); the embedded act is in the `proxy`'s
  content, so a middleware can judge *what* would be sent in j's name, not only
  who asked. On top of it `answerProxy` declines, with nothing put on the wire,
  following the existing rule that `not-understood` is for what the agent
  cannot read and `refuse` for what it will not do:
  - malformed `proxy` content → `not-understood` (the ordinary schema check);
  - an embedded act that fails envelope validation, or whose performative is
    outside the vocabulary → `not-understood`: j cannot tell what it is being
    asked to say;
  - a nested `proxy` or `propagate` in the embedded act →
    `refuse { verdict: "unsupported" }`, a depth-1 cap;
  - an empty target set, after dropping j itself and duplicates →
    `refuse { verdict: "unsupported" }`;
  - more explicit targets than `maxProxyTargets` →
    `refuse { verdict: "capacity" }`. A topic counts as one target: its fan-out
    is the bus's, and its size is unknown to j;
  - a `proxy` whose `:protocol` is `fipa-brokering` →
    `refuse { verdict: "unsupported" }` (D10).

  `forwarding: false` disables the act, falling back to
  `refuse { verdict: "unsupported" }` exactly as an unhonoured directive.

- **D6. The content schema and the settings.**
  ```ts
  proxy: {
    targets: { receivers?: string[]; topic?: string }, // exactly one populated
    message: <ACL message, no :receiver; :sender ignored>,
    constraint?: { maxTargets?: number },
  }
  ```
  `targets` mirrors a `CallRequest`'s `receivers`/`topic`, so the same code
  path addresses a forward as addresses a call. `constraint` is where FIPA's
  `φ` lives; only `maxTargets` is honoured in v1, and it can only tighten the
  agent's own limit. The settings follow `AgentConfig`'s flat style
  (`proposalTimeoutMs`, `supportedOntologies`): `forwarding?: boolean` (default
  `true`, D7) and `maxProxyTargets?: number` (default 100, `0` for no limit).

- **D7. Default behaviour.** *Recommend (agreed):* **honour `proxy` by default**,
  with the opt-out of D5. A FIPA-compliant framework should act on the acts it
  knows. The default is safe enough because the descriptor is always explicit —
  an explicit list or a named topic, never a catch-all — and every forward still
  passes the middleware gate. An agent that must not forward sets
  `forwarding: false` or declines in middleware.

- **D8. The terminal reply.** *Recommend:*
  `inform { forwarded: Forward[], failed: Forward[] }`, where a `Forward` is
  `{ target, replyWith }` — the target (or the topic) and the exchange its
  replies will name. That is what lets i pair each target's reply with the
  target, and the forward's ids with the ones i chose. `failure { reason,
  failed }` when no target could be sent to, and the declines of D5 otherwise.
  The reply stays in the `proxy`'s exchange (`conversationId`, `inReplyTo` =
  the `proxy`'s `replyWith`), as `answerQuery`'s does. A partial forward is not
  a failure — some targets heard it — so it is reported, not thrown.
  `forwarded` means *handed to the bus*, not *delivered*: the in-memory bus
  drops a message for an unregistered agent without an error, so `failed`
  lists only sends the transport rejected.

- **D9. The sender's bookkeeping.** *Recommend:* when i sends a `proxy`
  (through `sendMessage`, from a plan's `messages` or anywhere else), i stamps
  the embedded act's `conversationId` and `replyWith` if absent, the same
  stamping its own messages get, and its `replyBy` if it is a directive. i then
  registers the proxied exchange — the embedded `replyWith`, the act, its goal
  or name, and the allowed peers (the explicit targets; any peer for a topic) —
  so that:
  - j's `inform { forwarded, failed }` is filed against the `proxy` as
    `proxied.<j>.<exchange>` rather than as loose beliefs, and a `failed`
    target closes that target's leg;
  - a target's reply to the embedded act takes the path it would have taken had
    i sent the act itself. For an embedded `request`, `agree` promotes
    `intent.<target>.<goal>.<exchange>`; `inform { done: true }` records
    `done.*`; `failure` records `failed.*`; `refuse` records `infeasible.*`. For
    an embedded query, the answer settles `answer.<target>.<name>.<exchange>`.
    Today those paths look up `sentRequests` and `pendingQueries` by exchange
    for one peer. The proxied exchange makes the lookup per (exchange, peer),
    creating the record on the first reply from an allowed peer;
  - a reply from a peer the `proxy` did not name is an ordinary message, as for
    any exchange.

  *Alternative:* leave the sender untracked, which is the status quo for a
  forwarded exchange and the reason the first draft's end-to-end test would
  have passed while the requester's belief base filled with `msg.done`.

  A plan that wants to *wait* for a proxied request, as it waits for a
  delegation, is a natural follow-up; v1 only files the replies (see
  [Not covered](#not-covered)).

- **D10. The protocol.** *Recommend:* `openedProtocol("proxy")` is
  `fipa-recruiting`, so a `proxy` i sends carries it and j's reply echoes it.
  The forwarded act carries its own act's protocol (`fipa-request` for a
  `request`): it is a fresh exchange between j and the target, which is how
  SC00034 nests the sub-protocol. Since `protocol` is now stamped and echoed on
  every message, silently handling a `proxy` that claims `fipa-brokering` as
  recruiting would answer in a protocol j is not following, so it is refused
  (D5) until brokering exists.

- **D11. The forwarder's own echo.** An agent subscribed to a topic receives
  its own publishes, and a `request` from itself is admitted as a goal (only
  the replies to it are suppressed). So a topic forward would come back to j
  and j would work the job it was asked only to forward — contradicting "j is
  not a recipient". *Recommend:* `answerProxy` records the `replyWith` of each
  topic forward it publishes, and perception drops a message from j itself
  whose `replyWith` is in that record, once, without reasoning about it. The
  record is bounded like `exchangeProtocols`.

- **D12. Cancelling a proxied request.** The target only takes a `cancel` from
  the agent that asked — and in a forward that is j, not i. So i cannot cancel
  a recruited request directly; a direct `cancel` is answered
  `failure { reason: "nothing to cancel" }`. *Recommend:* say so, and note
  that the act composes: i can `proxy` the `cancel` itself through j, and the
  target accepts it because it comes from j and names the request's
  `replyWith`. Its reply reaches i through the defaulted `:reply-to`. No new
  code; one test pins it.

## Implementation

### 1. Vocabulary

- **`performatives.ts`:** a `FORWARD_DIRECTIVES` set and
  `isForwardDirective()`; subtract it in `isUnsupportedDirective`, which then
  names `propagate` alone; `proxy: "fipa-recruiting"` in `OPENED_PROTOCOLS`;
  update the module doc that groups `proxy` with `propagate` as declined.
- **`schemas.ts`:** `proxyContentSchema` (D6), registered in `CONTENT_SCHEMAS`.
- **`bus/index.ts`:** export `isForwardDirective`.
- **`types.ts`:** `forwarding?: boolean` and `maxProxyTargets?: number` on
  `AgentConfig`, defaulted in the constructor beside `supportedOntologies`;
  `ProxyForwarded` and `Forward` event types.

### 2. The forwarder

A new module `src/core/reasoning/forwarding.ts`, beside `cancellation.ts` and
`calls.ts`, holding `answerProxy(agent, msg)`:

1. decline if `forwarding` is off, or the `proxy` claims `fipa-brokering`
   (D5, D10);
2. read `targets`; drop j itself and duplicates; decline an empty set or one
   over the limit (D5);
3. validate the embedded act: envelope (with `sender`/`receiver` supplied, as
   they will be), a known performative, not `proxy`/`propagate` (D5);
4. build the forward — spread the embedded message, then set `sender: agent.id`
   and default `replyTo` to the `proxy`'s sender when absent (D4) — and send it
   with `sendMessageTo` for the explicit targets, or one `publishMessage` for a
   topic, recording a topic forward's `replyWith` for D11; collect each
   target's outcome;
5. reply per D8, and emit `proxy:forwarded`.

`agent.ts` gets an `/** @internal */ answerProxy(msg)` wrapper and a branch in
`considerDirective`'s terminal step, beside the `isQueryDirective` and
`isCallForProposals` branches. `perception.ts` adds `isForwardDirective` to the
condition that sends a directive to `considerDirective` (beside
`isCallForProposals`), and drops j's own topic echoes (D11).

A declined `proxy` already reports itself on `goal:refused` through
`declineDirective`, so no separate `proxy:refused` event is needed.

### 3. The sender

- **`messaging.ts`:** `sendMessage` and `publishMessage` stamp a `proxy`'s
  embedded act (D9) and register the proxied exchange.
- **`perception.ts` / `replies.ts`:** the reply lookups (`sentRequestFor`,
  `pendingQueryFor`) fall back to the proxied exchange for an allowed peer;
  j's `inform { forwarded, failed }` is filed as `proxied.<j>.<exchange>`.
- Proxied exchanges leave the registry when every allowed target's leg has
  ended, or on the embedded act's `reply-by` for a topic, bounded like
  `callExchanges`.

### 4. Docs and example

- **PERFORMATIVES.md:** the act's section, the `proxy` row set to **Done** as
  a forward, and the *Forwarding* section narrowed to `propagate`.
- **FIPA-COMPLIANCE.md:** issue 10's note narrowed to `propagate`.
- **README.md:** the *Directives the Agent Cannot Act On* section and the note
  under the class table narrowed to `propagate`; the envelope table gains
  `fipa-recruiting`; the config list gains `forwarding` and `maxProxyTargets`.
- **CONTRACT-NET.md:** the *Not covered* note drops `proxy`.
- `src/examples/proxy.ts`: a front-desk agent proxying a `request` to a topic
  of workers, and the reply reaching the original requester — the recruiting
  case, which is the whole point of the stateless design.

## Tests

`tests/proxy.test.ts`, using the harness style of `tests/contract-net.test.ts`.

Forwarder:

- Forwards to explicit receivers: each target receives the embedded act with
  `:sender` = the forwarder, `:receiver` = the target, the content intact, and
  the embedded `:reply-with`.
- Fan-out to a topic reaches every subscriber, and the forwarder does **not**
  work its own echo, even when subscribed to the topic (D11).
- Recruiting: an embedded `:reply-to` is preserved; when absent it is set to
  the `proxy`'s sender. The forwarder holds no tracking state for the forward.
- The sender receives `inform { forwarded }` in the `proxy`'s exchange, with
  each target's `replyWith`; a partial forward lists the rest in `failed`; a
  total failure is `failure`.
- Middleware decline → `refuse { verdict: "middleware" }`; `forwarding: false`
  → `refuse { verdict: "unsupported" }`; `fipa-brokering` → `refuse
  { verdict: "unsupported" }`; over `maxProxyTargets` → `refuse { verdict:
  "capacity" }`.
- Malformed content and an unreadable embedded act → `not-understood`; an empty
  target set, a self-only target set and a nested `proxy` → `refuse`. Nothing
  is put on the wire in any of them.
- **No goal and no queue slot is created** on the forwarder, however many
  targets there are.
- Protocols: the `proxy` and its reply carry `fipa-recruiting`; the forward
  carries `fipa-request`.

Sender, end to end with classic-agents agents:

- A proxied `request` becomes a goal on each target. Each target's `agree` and
  `inform { done: true }` reach the original requester and are filed under
  `intent.<target>.*` and `done.<target>.*` — **and no `msg.*` belief is
  written** for them or for the forwarder's `inform`.
- A proxied `query-if` settles `answer.<target>.<name>.<exchange>`.
- A reply naming the proxied exchange from an agent that was not a target is an
  ordinary message.
- Cancelling: a direct `cancel` from the requester is answered `failure`; a
  `cancel` proxied through the forwarder withdraws the request (D12).

## Risks

- **Being an open relay.** Honouring `proxy` by default means an agent will
  send messages in its own name on a peer's behalf — a confused deputy, since
  each target trusts j, not i. The descriptor is explicit and the middleware
  gate, which sees the embedded act, is between every request and any send, but
  the documentation must say plainly that forwarding is on by default and how
  to turn it off (D5, D7).
- **Amplification and self-loops.** One `proxy` to a topic can fan out to every
  subscriber, and a crafted target list can include the forwarder. Both are
  bounded (dedupe, drop self, `maxProxyTargets`, the echo filter of D11) but not
  eliminated; a hostile descriptor is the same class of risk as any broadcast.
- **The sender's bookkeeping widens two lookups.** `sentRequests` and
  `pendingQueries` are keyed by exchange for one peer; D9 makes a proxied
  exchange answerable by several. The change must not let a reply from a
  non-target settle anything.
- **Shared `reply-with` across targets.** Every target replies naming the same
  id. That is correct for FIPA and handled by sender, but a target that is
  *also* asked directly by i in another exchange must not collide; it cannot,
  since i stamps a fresh id per act.

## Not covered

- **Brokering** (SC00033): a stateful forwarder that keeps the proxied
  conversation's parameters and relays the target's replies back to the
  original sender. v1 is recruiting — the target answers the sender directly —
  and a `proxy` that claims `fipa-brokering` is refused (D10). This is the
  largest omission and the natural next increment; it would also let i cancel
  through j without proxying the `cancel` (D12).
- **Waiting for a proxied request.** A plan cannot yet hand work off through a
  broker and wait for it, as `ActionResult.delegations` waits for a direct
  request. D9's bookkeeping is what such a field would build on.
- **A named `fipa-recruiting` state machine.** As with the Propose protocol in
  `CONTRACT-NET.md`, the act is honoured and the protocol name carried, but the
  interaction protocol is not modelled as a conversation.
- **Referential-expression descriptors** (`iota`/`any`/`all x δ(x)`): v1
  resolves names (an explicit list or a topic), not predicates, per D2.
- **`constraint.φ` beyond `maxTargets`.** A hop limit and a time bound are where
  `propagate` needs them; `proxy` v1 keeps only a count.
- **Federation and cross-bus forwarding**, and any security model beyond the
  middleware gate.
- **`propagate`** (DC00050): the receiver as both a recipient and a forwarder,
  and chains of them. Its own plan; the rewrites and the directive handling
  here are the base it builds on.
