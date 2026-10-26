// How often the capacity screen re-reads the gateway (Story MOTIR-9539 ·
// MOTIR-9614). Client-safe: the screen's timer and its Freshness line both read
// this one constant, so the line can never print an interval the timer does not
// keep.
//
// Why 15 s: the load-target figures state no read interval for this API (the
// gateway contract §8 says so), and the contract asks for at most one read a
// second. Its per-minute counters are fixed clock-minute windows, so 15 s gives
// four readings per window — enough to watch a load test — at one gateway read
// and one alert evaluation per poll per open screen.

export const CAPACITY_SCREEN_REFRESH_MS = 15_000;
