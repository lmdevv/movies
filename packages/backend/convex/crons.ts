import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "pause rooms whose host went away",
  { seconds: 10 },
  internal.maintenance.sweepRooms,
);

crons.interval("expire device codes", { minutes: 1 }, internal.maintenance.expireDeviceCodes);

crons.interval(
  "release expired job leases",
  { minutes: 1 },
  internal.maintenance.releaseExpiredLeases,
);

crons.interval("end idle playback sessions", { minutes: 5 }, internal.maintenance.endIdlePlayback);

crons.daily(
  "request the nightly backup",
  { hourUTC: 3, minuteUTC: 0 },
  internal.maintenance.requestNightlyBackup,
);

export default crons;
