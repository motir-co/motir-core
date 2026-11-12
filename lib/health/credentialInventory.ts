// WHERE THE CREDENTIAL INVENTORY LIVES (MOTIR-9408). The inventory is a page in
// Motir's own MOTIR project, "Platform credential inventory": every credential
// the platform holds, where it is set, what it is for, its issuer, its source
// card and its expiry — names only. `CREDENTIAL_REGISTRY` is the subset of it
// that expires on a known date. It is a Motir page rather than a file here
// because it names Motir's own infrastructure (stores, apps, repositories),
// which this repository does not need to publish.
//
// The console's Credentials page links to it from its footer. The path is the
// page's address on Motir's own deployment, where the console is used.

export const CREDENTIAL_INVENTORY_PAGE_ID = 'cmwcwj8q100ie01adb2i88i7t';

export const CREDENTIAL_INVENTORY_HREF = `/pages/${CREDENTIAL_INVENTORY_PAGE_ID}`;
