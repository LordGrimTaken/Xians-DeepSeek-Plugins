/**
 * Host half of the Harness Rail bundle.
 *
 * Everything this package ships lives in the Client module (`client.js`): four
 * global main panels (Search, Sessions, Customize, Activity) registered through
 * the `main` + `sidebar.panellist` slots, plus the root-scope `shell.bottom`
 * status strip. The Host row exists only so the bundle has a normal plugin
 * entry; it owns no Host services, registers no Host slot, and needs no
 * teardown.
 */
export function apply() {}
