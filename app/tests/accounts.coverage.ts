// Public functions whose permissions are checked in accounts.test.ts rather than the matrix in
// permissions.test.ts (changing a password there would break the fixture's sign-ins).
export const ACCOUNTS_COVERED = ["passwords:change"];
