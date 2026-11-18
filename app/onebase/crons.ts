import { cronJobs } from "onebase/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("purge expired download tickets", { minutes: 30 }, internal.files.purgeTickets);
export default crons;
