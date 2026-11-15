// DOM slot ids the board page renders for its client board island to portal
// into. A plain module, not the client component, so the server page reads the
// real string (a 'use client' module's exports reach a server component as
// client references, not values).

/** The applied-filter row slot the stored-filter indicator portals into
 * (MOTIR-11335) — rendered by the board page beside `BoardAppliedFilterBar`. */
export const BOARD_STORED_FILTER_SLOT_ID = 'board-stored-filter-slot';
