import { Option } from "effect";

import { decodeRecord } from "../logging/log-query.ts";
import type * as RetainedLogs from "../logging/retained-logs.ts";

/** Queues `line`, a logger record, as logged at the time its `timestamp` names. */
export const appendRecord = (logs: RetainedLogs.Interface, line: string): void =>
  logs.append(
    line,
    Option.match(decodeRecord(line), {
      onNone: () => 0,
      onSome: (record) => Date.parse(record.timestamp),
    }),
  );
