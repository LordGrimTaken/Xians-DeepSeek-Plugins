/**
 * Host half of the Harness Chrome bundle.
 *
 * The whole feature lives in the Client module (`client.js`): a menu strip
 * registered into the Web UI's `conversation.header.leading` slot. The Host row
 * exists so the bundle has a normal plugin entry; it owns no services and needs
 * no teardown.
 */
export function apply() {}
