/// Where `.env` loading used to live.
///
/// The implementation moved to `@routelock/chain` when a second entry point —
/// the served API — needed to find the same file the same way. Re-exported
/// rather than deleted so the scripts importing it keep working, and so there
/// is exactly one parser rather than two that can drift.

export { loadDotEnv } from "@routelock/chain";
