/**
 * Host half of the Harness Deck bundle.
 *
 * The whole surface lives in the Client module (`client.js`): four right
 * Sidebar page types (`Side chat`, `Artifacts`, `Background tasks`,
 * `Reasoning trace`), their guide cards, the one-time auto-open of the right
 * column, and the one-time width nudge toward the Lamprey reference ratio.
 * The Host row exists so the bundle has a normal plugin entry; it owns no
 * services and needs no teardown.
 */
export function apply() {}
