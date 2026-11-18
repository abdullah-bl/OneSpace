// Public functions added by the UX redesign; each is checked per actor (× space where it applies)
// in ux.test.ts ("permission matrix: new public functions" and the mention/schedule blocks).
export const UX_COVERED = [
  "chat:spaceThreads",
  "chat:rename",
  "chat:retry",
  "mentions:suggest",
  "mentions:people",
  "mentions:inbox",
  "mentions:unreadCount",
  "mentions:markRead",
  "schedules:mine",
  "schedules:create",
  "schedules:update",
  "schedules:setEnabled",
  "schedules:remove",
  "schedules:runNow",
];
