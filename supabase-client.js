// Remove preferences and sessions saved by the retired Remember me flow.
try {
  window.localStorage.removeItem("hacienda-remember-tenant-session");
  window.localStorage.removeItem("hacienda-remember-tenant-email");
  window.localStorage.removeItem("hacienda-auth-persistence-mode");
  window.localStorage.removeItem("sb-nsdyciuirgyaezfnzwui-auth-token");
} catch (error) { /* Session-only authentication still works when local storage is blocked. */ }

window.supabaseClient = window.supabase.createClient(
  "https://nsdyciuirgyaezfnzwui.supabase.co",
  "sb_publishable_1o7739wCEgp0n1Kej7e5dA_krnKtd_Z",
  { auth: { storage: window.sessionStorage, persistSession: true } }
);
