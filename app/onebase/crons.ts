import { cronJobs } from "onebase/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("purge expired download tickets", { minutes: 30 }, internal.files.purgeTickets);
crons.interval("purge expired document tickets", { minutes: 30 }, internal.documents.purgeTickets);
crons.interval("purge expired publication tickets", { minutes: 30 }, internal.publications.purgeTickets);
crons.interval("purge expired app test links", { minutes: 30 }, internal.apps.purgeTests);
// plans/13: plans/11 quiz publications become apps whose handler marks them (a no-op once none are left).
crons.interval("migrate quiz forms to apps", { minutes: 30 }, internal.apps.migrateQuizForms);
// Scheduled tasks (schedules.ts): fire what is due, as its creator, every minute.
crons.interval("run scheduled tasks", { minutes: 1 }, internal.schedules.tick, {});
// Folder sync (folderSync.ts): copy due folders into their spaces. Does nothing without SYNC_ROOT.
crons.interval("sync folders", { minutes: 5 }, internal.folderSync.tick, {});
export default crons;
