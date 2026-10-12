import { useEffect, useState } from "react";

/** The current time, refreshed every `intervalMs`, so relative times such as “2 min ago” age. */
export const useNow = (intervalMs = 30_000): number => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);

    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
};
