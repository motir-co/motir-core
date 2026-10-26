// The typed failure of the operator console's gateway status read (MOTIR-9641).
//
// ONE class, because the console does one different thing for it. Every other
// failure of the read — the deadline passing, a refused connection, a DNS miss —
// means the gateway gave NO answer, and the card says so. This one means the
// gateway DID answer, and the answer could not be read: a non-2xx, a body that is
// not JSON, or a body `parseStatus` rejects. Reporting that as "no answer within
// 3 s" sends an operator chasing the network for a gateway that replied in 100 ms.

/** Why an answer was rejected — a CODE the console's copy names in words. */
export type GatewayStatusRejection =
  | 'httpStatus'
  | 'notJson'
  | 'noSuccess'
  | 'noData'
  | 'noVersion'
  | 'noStartTime';

export class GatewayStatusMalformedError extends Error {
  constructor(
    readonly why: GatewayStatusRejection,
    message: string,
    /** The HTTP status the gateway answered with, on a `httpStatus` rejection. */
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
