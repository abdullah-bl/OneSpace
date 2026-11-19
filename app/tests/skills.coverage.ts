// Public functions added with skills, stop and AI drafts (plans/07). Each is checked per actor in
// skills.test.ts; permissions.test.ts includes this list in its "every public function" check.
export const SKILLS_COVERED = [
  "chat:stop",
  "skills:list",
  "skills:create",
  "skills:update",
  "skills:remove",
  "skills:draftFromThread",
  "agentDrafts:draftWithAI",
  "home:suggestions",
  "levels:list",
  "levels:save",
  "levels:remove",
  "levels:setDefault",
  "levels:assign",
  "levels:mine",
  // plans/09 §2, checked in space-skills.test.ts
  "skills:space",
  "skills:addSpace",
  "skills:shareToSpace",
  "skills:reviewSpace",
  "skills:updateSpace",
  "skills:removeSpace",
  "skills:forChat",
  "skills:parseImport", // checked in skill-import.test.ts
];
