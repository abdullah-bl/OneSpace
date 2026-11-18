import { password } from "onebase/auth";

// Local passwords. Anyone can sign up (onebase has no switch to close sign-up), but every new
// account is born "pending" and sees nothing until a workspace admin activates it.
// The profile hook only copies a display name; the status is fixed here, never taken from the client.
const displayName = (value: unknown) => (typeof value === "string" && value.trim() ? { name: value.trim().slice(0, 100) } : {});

export default {
  methods: [password({ minLength: 8, profile: (params) => ({ ...displayName(params.name), status: "pending" }) })],
};
