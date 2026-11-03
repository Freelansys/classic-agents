import { afterEach, expect } from "vitest";
import { Agent } from "../../src/core/reasoning/index.js";
import { staleIntentions } from "../../src/core/reasoning/persistence.js";

/**
 * Checks, after every cycle of every agent in the suite, that each intention
 * on the stack has the records it should in the belief base: a change made
 * without the stack would leave a record behind the intention it keeps.
 */
const stale: string[] = [];
const tick = Agent.prototype.tick;
Agent.prototype.tick = async function (this: Agent, ...args) {
  try {
    return await tick.apply(this, args);
  } finally {
    for (const id of staleIntentions(this)) stale.push(`${this.id}/${id}`);
  }
} as typeof tick;

afterEach(() => {
  const found = stale.splice(0);
  expect(found, "intentions whose kept record is stale").toEqual([]);
});
