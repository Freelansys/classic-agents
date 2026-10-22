# Middleware

Two decisions an agent makes about what it is told: whether to believe it, and
whether to do it. They get two separate chains, because an application
frequently wants one without the other.

- **`middleware`** — the belief chain. Gates every assertion before it is
  written.
- **`directiveMiddleware`** — the directive chain. Gates every directive before
  it becomes a goal, an answer or a commitment.

Both are empty by default, which means the cooperative behaviour: believe what
you are told, agree to what you are asked. This file is about withdrawing that.

- [Trust is the default, and it is interruptible](#trust-is-the-default-and-it-is-interruptible)
- [Work is guarded too](#work-is-guarded-too)
- [The two chains side by side](#the-two-chains-side-by-side)

## Trust is the default, and it is interruptible

classic-agents assumes agents are trustworthy and cooperative, so an
unconfigured agent believes what it is told. That is an assumption about the
social world, not a guarantee FIPA makes: `inform` compels nothing, and the
cooperative peer who *would* update is a presupposition rather than a rule. A
user who does not hold it needs an interruption point on the write itself, not
a filter bolted on the front — which is what `middleware` is:

```typescript
const agent = new Agent({
  id: "qualifier",
  bus,
  planLibrary,

  middleware: [
    // Express-shaped: call next() to continue, or return without calling it to
    // cancel. Runs per message, so it sees the whole assertion.
    async (msg, next) => {
      if (!(await acl.may(msg.sender, "assert", msg.content))) {
        return; // no belief is written
      }
      await next();
    },
  ],
});
```

Empty by default, which means the write happens. The chain is async because real
authorization is: checking a capability service is I/O, and a synchronous chain
would push every caller into blocking or fire-and-forget. The chain is the only
gate: a class-level rule is just the same entry with the test hoisted out, and a
message stopped anywhere in it is reported as a `belief:rejected` event.

A write stopped by the belief chain is reported as a `belief:rejected` event (a
directive the directive chain declines is reported as `goal:refused` instead —
see below):

```typescript
agent.on("belief:rejected", ({ agentId, reason, message }) => {
  logger.warn({ agentId, reason, from: message.sender }, "assertion not believed");
});
```

It is an event rather than a message on the bus deliberately. A rejection is a
fact about *this* agent's reasoning, not anything communicated to anyone: there
is no hearer and no performative in it. Publishing it as an `inform` would have
made it something a peer could subscribe to and believe — and an agent that did
would then hold a belief about its own bookkeeping, governed by the same trust
assumption it applies to strangers. Observability goes through events; the bus is
for communication and nothing else.

A directive asks the receiver to act rather than to believe, so its content
never becomes a belief and the belief chain does not see it. See
[MESSAGING.md](MESSAGING.md) › *Assertions, directives and replies*.

## Work is guarded too

A `request` is not obliged, only compelled to be noticed, and the agent's default
is the cooperative one: agree to every well-formed request it has a plan for and
capacity to take. `directiveMiddleware` is where a user withdraws that.

Note the **three** arguments. The belief chain takes `(msg, next)` because an
assertion that is not believed needs no reply — declining is just not continuing.
A directive compels a hearer effect, so declining it is itself a communicative
act, and "no" without a reason is worse than silence: the sender learns that
nothing will happen but not whether the agent *could not*, *would not*, or *has
no room*. Hence `res`:

```typescript
const agent = new Agent({
  id: "worker",
  bus,
  planLibrary,

  directiveMiddleware: [
    async (req, res, next) => {
      if (!(await acl.may(req.sender, "request", req.content))) {
        res.refuse("middleware", "sender not permitted to direct me");
        return;
      }
      await next();
    },
  ],
});
```

`res.refuse(verdict?, reason?)` sets the answer. `verdict` is from the fixed
`RefusalVerdict` vocabulary and defaults to `"middleware"`, meaning the
application declined rather than the agent lacking something; `reason` is FIPA's
φ, free text forwarded to the sender verbatim, and is where the explanation a user
actually wants to read goes. Name a different verdict when the chain knows more —
`res.refuse("capacity", …)` to shed load before the queue is consulted.

It is terminal: once called the goal is not admitted, whatever the rest of the
chain does, so calling `next()` afterwards is harmless but will not admit the
work. The first reason given is kept, since the handler closest to the request
has the most specific view of it.

The chain runs before the content is parsed — so a handler can rewrite
`req.content`, including to supply a goal name a malformed request omitted — and
before the plan check, the goal bound and the `agree`, so a decline short-circuits
all of them.

Cancelling without calling `next` also answers, with `verdict: "middleware"` and
`reason: "cancelled by middleware"` — no verdict is available, because a handler
that simply stops said nothing about why, but the text still is what separates a
deliberate cancel from a chain that fell off the end. A middleware that throws
declines the same way, with the error text as the reason. Either way it is
reported as `goal:refused`.

A directive whose content is still malformed once the chain has had its chance —
most commonly a request that names no goal — is answered `not-understood`, with
the schema violation as the reason. This is FIPA's own answer for "the hearer was
compelled but did not grasp the content", and it is distinct from a `refuse`,
which says the content was understood and declined.

What a resolved directive then becomes — an `agree`, a `refuse` with its
verdict, a goal — is [MESSAGING.md](MESSAGING.md) › *Answering a directive*.

## The two chains side by side

| | `middleware` | `directiveMiddleware` |
| --- | --- | --- |
| Gates | an assertion | a directive |
| Signature | `(msg, next)` | `(req, res, next)` |
| Continue | `await next()` | `await next()` |
| Decline | return without calling `next()` | `res.refuse(verdict?, reason?)`, or return |
| Declining does | nothing (no reply owed) | answers the sender with `refuse` |
| Runs | before an assertion is written | before parsing, the plan check, the bound and the `agree` |
| Decline reported as | `belief:rejected` | `goal:refused` |
| Empty chain means | believe it | agree to it |

Both chains may be async, and both apply to messages from any transport. Neither
sees outgoing messages; to translate a conversation for a peer that is not
classic-agents, wrap the transport instead — see
[DELEGATION.md](DELEGATION.md) › *Not covered*.
