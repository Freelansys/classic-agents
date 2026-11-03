import { afterEach, expect } from "vitest";
import { Agent } from "../../src/core/reasoning/index.js";
import { staleIntentions } from "../../src/core/reasoning/persistence.js";

/**
 * Checks, after every cycle of every agent in the suite, that each intention
 * the agent tracks has the record it should in the belief base: a change the
 * tracking missed would leave a record behind the intention it keeps.
 */
const stale: string[] = [];
const tick = Agent.prototype.tick;
Agent.prototype.tick = async function (this: Agent, ...args) {
  try {
    return await tick.apply(this, args);
  } finally {
    // The records are written once the cycle's last change has been made.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    for (const id of staleIntentions(this)) stale.push(`${this.id}/${id}`);
  }
} as typeof tick;

afterEach(() => {
  const found = stale.splice(0);
  expect(found, "intentions whose kept record is stale").toEqual([]);
});
