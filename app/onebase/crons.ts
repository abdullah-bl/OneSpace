import { cronJobs } from "onebase/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("purge expired download tickets", { minutes: 30 }, internal.files.purgeTickets);
crons.interval("purge expired document tickets", { minutes: 30 }, internal.documents.purgeTickets);
// Scheduled tasks (schedules.ts): fire what is due, as its creator, every minute.
crons.interval("run scheduled tasks", { minutes: 1 }, internal.schedules.tick, {});
export default crons;
