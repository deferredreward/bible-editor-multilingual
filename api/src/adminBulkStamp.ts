// The admin bulk-sweep stamp (`admin_bulk_state`, migration 0070) expressed as
// SQL fragments, shared by the bulk route (reviewState.ts) and the per-row
// validate helpers (rows.ts) so the two can never drift apart. Pure leaf module
// — no Env, no Hono — so the node strip-types runner can exercise the exact
// fragments production runs, the same reason contentPatchClauses.ts exists.
//
// Stamp semantics (issue #296): NULL means the row's translation_state is the
// pipeline's or a human's. Otherwise the value is the state the row held
// immediately before the admin sweep validated it, with 'none' encoding a
// pre-sweep NULL.

/** SQL expression: the state a stamped row held before the sweep. */
export const PRE_SWEEP_STATE =
  "CASE admin_bulk_state WHEN 'none' THEN NULL ELSE admin_bulk_state END";

/** SQL expression: the stamp value to write when a sweep validates a row. */
export const CAPTURE_PRE_SWEEP_STATE = "COALESCE(translation_state, 'none')";

/** SET fragment retiring the stamp — the row's state is a human's from now on. */
export const RETIRE_STAMP = "admin_bulk_state = NULL";

/**
 * The `translation_state = ...` expression for the PER-ROW validate/un-validate
 * helpers, where `param` is the bind index holding the target state
 * ('validated' | 'edited' | null).
 *
 * Approve behaves exactly as it always has. **Un-approve of a row this sweep
 * put into 'validated' restores its pre-sweep state instead of landing on
 * 'edited'** — otherwise a translator un-approving one swept row would strand a
 * never-drafted imported row at 'edited' forever, which the export gate treats
 * very differently from NULL (publishGate omits NULL-state rows on foreign-
 * provenance chapters but ships snapshot-backed 'edited' ones). Rows with no
 * stamp fall through to the plain target state, so nothing that predates
 * migration 0070 changes behaviour.
 */
export function perRowStateExpr(param: number): string {
  return (
    `CASE WHEN ?${param} = 'validated' THEN ?${param}` +
    ` WHEN admin_bulk_state IS NOT NULL THEN ${PRE_SWEEP_STATE}` +
    ` ELSE ?${param} END`
  );
}
