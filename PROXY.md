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
and `propagate` as recognised directives but stands behind JADE and SPADE,
neither of which implements forwarding: a `proxy` or `propagate` is answered
`refuse { verdict: "unsupported" }` rather than forwarded. The vocabulary in
[PERFORMATIVES.md](PERFORMATIVES.md) is therefore closed — rows 80–81 are
**Done** as refusals — and FIPA-COMPLIANCE.md issue 10 is **Fixed**. This
document is the design for adding real forwarding in a later release; the
`refuse` is what buys the time to build it.

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

`proxy` needs almost nothing new. The two things it does — resolve a name to
agents, and send a message — are the bus's job already.

| Proxy needs | Already in place |
| --- | --- |
| A name the receiver resolves to agents | bus `topic` and explicit receiver ids, exactly as `CallRequest` uses for a `cfp` |
| A message to send, in the library's envelope | `Message`, `sendMessage`, `publishMessage` |
| Sending in the agent's own name | `sendMessage` already stamps `sender` and correlating ids; only absence is filled, so an embedded message's own ids survive |
| A consent gate before forwarding | `directiveMiddleware` through `considerDirective`, the same chain every honoured directive runs |
| A directive the receiver *answers* rather than *works* | `answerQuery` / `answerCfp`: the terminal step of `considerDirective` that sends an answer and creates no goal |
| Content validation | `CONTENT_SCHEMAS` in `schemas.ts` |
| A reply the sender can read | the existing `inform` / `failure` / `refuse` / `not-understood` vocabulary |

**What is genuinely new** is small: a content schema, one new directive
classification, and one terminal handler that forwards and answers.

The consequence worth stating: because forwarding is immediate bus work, not
long-running plan work, `proxy` behaves like a **query** — the receiver
answers it in the tick it is admitted — and **not** like a `request`, which
becomes a goal served by a plan. This is the central decision, D3.

## Decisions to agree

Record each in PERFORMATIVES.md before implementing. Each has a recommendation.

- **D1. Is `proxy` a directive?** *Recommend:* yes. Set
  `PERFORMATIVE_CLASSES.proxy = ["directive"]` and add a `"forward directive"`
  group beside `isCallForProposals`, with `isForwardDirective()` and a
  subtraction in `isUnsupportedDirective`. `proxy` compels the hearer to act
  (forward), so it belongs in the directive class and must not be silently
  treated as an assertion. *Alternative:* leave it unclassified and answer
  `not-understood`. That is the status quo, and it refuses an act FIPA says the
  agent can honour.

- **D2. What the descriptor is.** FIPA's descriptor is a referential expression
  (`iota x δ(x)`, `any x δ(x)`, `all x δ(x)`) evaluated against a directory.
  This library's rule is that *the wire carries a name, and the receiver owns
  what is behind it* (the same rule that makes a `Plan.bid` a named expression
  and a query a named proposition). *Recommend:* reuse the two addressing forms
  a call already has — an explicit `receivers: string[]` or a `topic` string.
  An explicit list is used as-is; a topic is a `publishMessage` fan-out.
  *Alternative:* a registered named group the agent resolves through a
  resolver interface. That is more FIPA-faithful but adds a registry and an
  evaluation, and can come later behind the same `targets` field.

- **D3. Answered or worked.** *Recommend:* answered, like a query and a `cfp`.
  `answerProxy` runs after the middleware chain and sends the terminal reply
  directly; no goal is created, no queue slot is used, and no `agree` is sent.
  Forwarding is a bus send performed inside the tick, so there is no later work
  to defer and nothing for an `agree` to commit to. *Alternative:* admit a goal
  served by a plan, so the application controls forwarding. That puts protocol
  work in plan bodies, breaks the "an agent honours every CAL directive with no
  plan required" property `cfp` just established, and would make every agent
  that can forward need a plan for it.

- **D4. The forwarding rewrites.** *Recommend:* per FIPA — `:sender` = j, the
  `proxy`'s receiver; `:receiver` = the denoted target. Preserve the embedded
  message's own `:reply-to`, `:conversation-id`, `:reply-with` and `:reply-by`;
  `sendMessage` only fills absent values, so ids the embedded act already
  carries survive with no special handling. When the embedded act has **no**
  `:reply-to`, set it to the `proxy`'s sender (i), the recruiting reading, so a
  target's answer reaches the original requester and j keeps no state.
  *Alternative:* leave `:reply-to` unset, which forces every reply back through
  j and makes brokering mandatory. That is the stateful relay C3 declines to
  build.

- **D5. Consent, safety and limits.** A forwarder is an open relay unless told
  otherwise, so the middleware gate is load-bearing. *Recommend:* the
  `directiveMiddleware` chain is the consent gate (a veto is
  `refuse { verdict: "middleware" }`), and on top of it `answerProxy` refuses,
  with nothing put on the wire:
  - malformed content → `not-understood` (via the ordinary schema check);
  - an embedded act whose performative the vocabulary does not know →
    `refuse { verdict: "unsupported" }`;
  - a nested `proxy` or `propagate` in the embedded act → `refuse`, a depth-1
    cap;
  - an empty target set → `refuse { verdict: "unsupported" }`;
  - itself among the targets → dropped, as is a duplicate, before sending.
  A `proxyConfig.enabled: false` setting disables the act, falling back to
  `refuse { verdict: "unsupported" }` exactly as an unhonoured directive.

- **D6. The content schema.**
  ```ts
  proxy: {
    targets: { receivers?: string[]; topic?: string }, // exactly one populated
    message: <ACL message, no :receiver (and no :sender)>,
    constraint?: { maxTargets?: number },
  }
  ```
  `targets` mirrors a `CallRequest`'s `receivers`/`topic`, so the same code
  path addresses a forward as addresses a call. `constraint` is where FIPA's
  `φ` lives; only `maxTargets` is honoured in v1 (see
  [Not covered](#not-covered)).

- **D7. Default behaviour.** *Recommend (agreed):* **honour `proxy` by default**,
  with the config opt-out of D5. A FIPA-compliant framework should act on the
  acts it knows; the conservative silence of today is the bug issue 10 records.
  The default is safe because the descriptor is always explicit — an explicit
  list or a named topic, never a catch-all — and every forward still passes the
  middleware gate. An agent that must not forward sets
  `proxyConfig.enabled: false` or declines in middleware.

- **D8. The terminal reply.** *Recommend:*
  `inform { forwarded: string[], failed: string[] }` for a forward that
  delivered to at least one target, `failure { reason, forwarded, failed }`
  when none could be delivered, and the ordinary refusals of D5 otherwise. The
  reply stays in the `proxy`'s exchange (`conversationId`, `inReplyTo` =
  the `proxy`'s `replyWith`), as `answerQuery`'s reply does. A partial forward
  is not a failure — some targets heard it — so it is reported, not thrown.

## Implementation

### 1. Vocabulary

- **`performatives.ts`:** set `proxy: ["directive"]`; add a `FORWARD_DIRECTIVES`
  set and `isForwardDirective()`; subtract it in `isUnsupportedDirective` (which
  still returns `false` for the whole vocabulary, since `proxy` now honours);
  update the module doc at lines 54–57 that currently says `proxy` and
  `propagate` are unclassified.
- **`schemas.ts`:** `proxyContentSchema` (D6), registered in `CONTENT_SCHEMAS`.
- **`bus/index.ts`:** export `isForwardDirective`.
- **`types.ts`:** `proxyConfig?: { enabled?: boolean; maxTargets?: number }` on
  `AgentConfig`, defaulted in the constructor beside `proposalTimeoutMs`.

### 2. The forwarder

A new module `src/core/reasoning/forwarding.ts`, beside `cancellation.ts` and
`calls.ts`, holding `answerProxy(agent, msg)`:

1. read `targets`; collect the concrete list (explicit ids, or a topic);
2. if `enabled` is false or the list is empty after dropping self and
   duplicates, decline per D5;
3. validate the embedded act: a known performative, not `proxy`/`propagate`,
   within `maxTargets` (D5);
4. for each target, build the forwarded message — spread the embedded message,
   then set `sender: agent.id`, `receiver: target`, and default `replyTo` to
   the `proxy`'s sender when absent (D4) — and `sendMessage` (or one
   `publishMessage` for a topic), collecting the outcome;
5. reply per D8.

`agent.ts` gets an `/** @internal */ answerProxy(msg)` wrapper and a branch in
`considerDirective`'s terminal, beside the `isQueryDirective` and
`isCallForProposals` branches:

```ts
if (isForwardDirective(msg.performative)) {
  this.answerProxy(msg);
  return;
}
```

`perception.ts` includes `isForwardDirective(message.performative)` in the
condition that routes a directive to `considerDirective` (line 242), so the act
reaches admission instead of falling through silently. With that,
`isUnsupportedDirective` no longer catches `proxy`, and `propagate` becomes the
only act left in `handleUnsupportedDirective`.

Events: `proxy:forwarded` and `proxy:refused`, so a monitor sees a forwarder's
work on its own stream as well as the sender hearing the reply.

### 3. Docs and example

- **PERFORMATIVES.md:** the act's section, and the `proxy` row set to **Done**;
  the note at line 84 shrinks to `propagate`.
- **FIPA-COMPLIANCE.md:** issue 10 shrinks to `propagate`; the suggested
  treatment at line 561 applies to `propagate` alone.
- **README.md:** remove `proxy` from *Directives the Agent Cannot Act On*
  (line 858) and from the unclassified note (line 77), leaving `propagate` in
  both.
- **CONTRACT-NET.md:** the "Not covered" note at line 482 drops `proxy`.
- `src/examples/proxy.ts`: a front-desk agent proxying a `request` to a topic
  of workers, and the reply reaching the original requester — the recruiting
  case, which is the whole point of the stateless design.

## Tests

`tests/proxy.test.ts`, using the harness style of `tests/contract-net.test.ts`.

- Forwards to explicit receivers: each target receives the embedded act with
  `:sender` = the forwarder, `:receiver` = the target, and the content intact.
- Fan-out to a topic reaches every subscriber of that topic.
- Recruiting: an embedded `:reply-to` is preserved; when absent it is set to
  the `proxy`'s sender, and the target's answer reaches the original requester
  end to end.
- The sender receives `inform { forwarded }` in the `proxy`'s exchange; a
  partial forward lists the rest in `failed`; a total failure is `failure`.
- Middleware decline → `refuse { verdict: "middleware" }`; disabled via config →
  `refuse { verdict: "unsupported" }`.
- Malformed content → `not-understood`; an unknown embedded performative, an
  empty target set, a nested `proxy`, and a self-only target are each refused
  with nothing put on the wire.
- **No goal and no queue slot is created** on the forwarder, however many
  targets there are.
- End to end with classic-agents agents: a proxied `request` becomes a goal on
  the target and its `inform` returns to the original requester.

## Risks

- **Being an open relay.** Honouring `proxy` by default means an agent will
  send messages on a peer's behalf. The descriptor is explicit and the
  middleware gate is between every request and any send, but the documentation
  must say plainly that forwarding is on by default and how to turn it off
  (D5, D7).
- **Amplification and self-loops.** One `proxy` to a topic can fan out to every
  subscriber, and a crafted target list can include the forwarder. Both are
  bounded (dedupe, drop self, `maxTargets`) but not eliminated; a hostile
  descriptor is the same class of risk as any broadcast.
- **Protocol name not registered.** FIPA carries `:protocol fipa-recruiting`
  or `fipa-brokering`; v1 does not read it (see [Not covered](#not-covered)).
  The stateless behaviour it implements *is* recruiting, so a message claiming
  `fipa-brokering` would be handled as recruiting. The documentation must say
  so.
- **Single receiver per message (issue 12).** A forward to N targets is N
  sends, each its own exchange; the `proxy`'s reply groups them.

## Not covered

- **Brokering** (SC00033): a stateful forwarder that keeps the proxied
  conversation's parameters and relays the target's replies back to the
  original sender. v1 is recruiting — the target answers the sender directly.
  This is the largest omission and the natural next increment.
- **A named `fipa-proxy`/`fipa-brokering`/`fipa-recruiting` state machine.**
  Like the Propose protocol in `CONTRACT-NET.md`, the act is honoured but the
  named interaction protocol is not modelled as a conversation.
- **Referential-expression descriptors** (`iota`/`any`/`all x δ(x)`): v1
  resolves names (an explicit list or a topic), not predicates, per D2.
- **`constraint.φ` beyond `maxTargets`.** A hop limit and a time bound are where
  `propagate` needs them; `proxy` v1 keeps only a count.
- **Federation and cross-bus forwarding**, and any security model beyond the
  middleware gate.
- **`propagate`** (DC00050): the receiver as both a recipient and a forwarder,
  and chains of them. Its own plan; the rewrites and the directive handling
  here are the base it builds on.
