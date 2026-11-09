/**
 * Host half of the In-house Browser bundle.
 *
 * The page itself lives entirely in the Client module (`client.js`): it is a
 * React surface registered into the Web UI's `main` and `sidebar.panellist`
 * slots. The Host row exists so the bundle has a normal plugin entry; it owns
 * no services and needs no teardown.
 */
export function apply() {}
