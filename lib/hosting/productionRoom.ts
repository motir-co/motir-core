// The Production settings room's addresses (Story MOTIR-9797 · MOTIR-10037), in a
// plain module so a server component and a client island read one value (a
// constant exported from a `'use client'` file reaches a server component as a
// client reference, not as the string).

/** The room itself; `?repository=<rowId>` selects a repository. */
export const PRODUCTION_ROOM_HREF = '/settings/project/production';

/** The Public address room the no-address note links to (MOTIR-9790 §1). */
export const PUBLIC_ADDRESS_HREF = '/settings/project/public-address';
