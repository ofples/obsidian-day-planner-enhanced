/** Shared budget is passed across streams, so many containers cannot multiply it. */
export class SourcePageBudget {
  private pages = 0;
  private items = 0;

  constructor(
    private readonly maxPages = 20,
    private readonly maxItems = 2000,
  ) {}

  get pageSize() {
    return Math.max(0, Math.min(100, this.maxItems - this.items));
  }

  get available() {
    return this.pages < this.maxPages && this.pageSize > 0;
  }

  reserve() {
    if (!this.available)
      throw new Error("The source refresh budget is exhausted.");
    this.pages++;
    return this.pageSize;
  }

  received(count: number) {
    this.items += count;
  }
}

export interface SourcePageState {
  id: string;
  containerId?: string;
  complete: boolean;
  cursor?: string;
  error?: string;
}

export interface SourceCoverage {
  complete: boolean;
  streams: SourcePageState[];
  unavailableItems?: number;
}

export async function readSourcePages<T>(
  id: string,
  budget: SourcePageBudget,
  fetch: (
    limit: number,
    cursor?: string,
  ) => Promise<{ items: T[]; next?: string }>,
  start?: SourcePageState,
): Promise<{ items: T[]; state: SourcePageState }> {
  if (start?.complete || start?.error) return { items: [], state: start };
  let cursor = start?.cursor;
  const seen = new Set<string>();
  if (cursor) seen.add(cursor);
  const items: T[] = [];
  while (budget.available) {
    const limit = budget.reserve();
    const page = await fetch(limit, cursor);
    if (page.items.length > limit)
      throw new Error("The source returned more items than requested.");
    budget.received(page.items.length);
    items.push(...page.items);
    if (!page.next) return { items, state: { id, complete: true } };
    if (seen.has(page.next))
      return {
        items,
        state: {
          id,
          complete: false,
          error:
            "The source repeated a page cursor. Use Refresh to restart this read.",
        },
      };
    cursor = page.next;
    seen.add(cursor);
  }
  return {
    items,
    state: { id, complete: false, ...(cursor ? { cursor } : {}) },
  };
}
