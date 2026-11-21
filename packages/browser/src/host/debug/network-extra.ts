/** ExtraInfo streams are ordered independently of base events, but share redirect IDs.
 * Wait for each hop's explicit CDP flag before consuming either FIFO. */
export function createExtraInfo<T>(
  apply: (
    item: T,
    kind: "requestHeaders" | "responseHeaders",
    headers: Record<string, string>,
  ) => void,
) {
  type Hop = {
    item: T;
    expected?: boolean;
    requestHeaders: boolean;
    responseHeaders: boolean;
  };
  const chains = new Map<
    string,
    {
      invalid?: boolean;
      hops: Hop[];
      requestHeaders: Record<string, string>[];
      responseHeaders: Record<string, string>[];
    }
  >();
  let stopped = false;
  const chain = (id: string) => {
    let value = chains.get(id);
    if (!value) {
      if (stopped) return { invalid: true, hops: [], requestHeaders: [], responseHeaders: [] };
      value = { hops: [], requestHeaders: [], responseHeaders: [] };
      chains.set(id, value);
      if (chains.size > 100) {
        stopped = true;
        for (const existing of chains.values()) existing.invalid = true;
      }
    }
    return value;
  };
  const flush = (id: string) => {
    const value = chain(id);
    if (value.invalid) return;
    for (const kind of ["requestHeaders", "responseHeaders"] as const) {
      for (const hop of value.hops) {
        const expected = hop.expected;
        if (expected === undefined) break;
        if (!expected || hop[kind]) continue;
        const headers = value[kind].shift();
        if (!headers) break;
        apply(hop.item, kind, headers);
        hop[kind] = true;
      }
    }
  };
  const invalidate = (id: string) => {
    const value = chain(id);
    value.invalid = true;
    value.hops.length = 0;
    value.requestHeaders.length = 0;
    value.responseHeaders.length = 0;
  };
  return {
    invalidate,
    start(id: string, item: T, redirect: boolean, previousExtra?: boolean) {
      const value = chain(id);
      const previous = value.hops.at(-1);
      if (value.invalid) return;
      if (previous && !redirect) {
        invalidate(id);
        return;
      }
      if (redirect && previous) previous.expected = previousExtra;
      // Missing predecessor/flag makes subsequent FIFO attribution uncertain. Drop the
      // entire chain rather than ever bind old-origin headers to the new hop.
      if ((redirect && (!previous || previousExtra === undefined)) || value.hops.length >= 32) {
        invalidate(id);
        return;
      }
      value.hops.push({ item, requestHeaders: false, responseHeaders: false });
      flush(id);
    },
    response(id: string, expected?: boolean) {
      const hop = chains.get(id)?.hops.at(-1);
      if (!hop) return;
      if (expected === undefined) {
        invalidate(id);
        return;
      }
      hop.expected = expected;
      flush(id);
    },
    extra(id: string, kind: "requestHeaders" | "responseHeaders", headers: Record<string, string>) {
      const value = chains.get(id);
      // ExtraInfo before any base event is safely discarded, and this chain can no
      // longer consume a partial FIFO. Its base metadata is still useful.
      if (!value) {
        invalidate(id);
        return;
      }
      if (value.invalid) return;
      if (value[kind].length >= 32) {
        invalidate(id);
        return;
      }
      value[kind].push(headers);
      flush(id);
    },
    end(id: string) {
      chains.delete(id);
    },
    stop() {
      chains.clear();
      stopped = true;
    },
    clear() {
      chains.clear();
      stopped = false;
    },
  };
}
