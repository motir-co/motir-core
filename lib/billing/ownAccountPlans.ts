import { BILLING_CATALOG, largerPoolPlans } from '@/lib/billing/catalog';
import { HOST_PLAN_KEY } from '@/lib/billing/planCaps';

// WHICH PLANS CARRY AWS ACCOUNTS OF THE ORG'S OWN (Story MOTIR-9366 · MOTIR-9651).
// Host (MOTIR-9365) and every larger pool ON SALE bring the same three own
// accounts; the ladder, Free and the retired rungs at or below Host do not. This
// is the ONE definition — the account reconcile selects with it, and admission
// and the caps read it — so selection and admission can never disagree about
// which orgs have accounts. Every key and pool is read from the catalog: Host's
// entry and `largerPoolPlans()`, whose floor is what retires a rung. Pure: no
// `db`, no `process.env`.

/** True when an org on `planKey` gets its own three AWS accounts. */
export function planCarriesOwnAccounts(planKey: string): boolean {
  return ownAccountPoolCredits(planKey) !== null;
}

/** The monthly pool of a plan that carries its own accounts, read from its
 *  catalog entry — or null for any plan that does not. */
export function ownAccountPoolCredits(planKey: string): number | null {
  const entry =
    planKey === HOST_PLAN_KEY
      ? BILLING_CATALOG.aiPlans.find((p) => p.key === HOST_PLAN_KEY)
      : largerPoolPlans().find((p) => p.key === planKey);
  return entry?.allotment?.cadence === 'monthly' ? entry.allotment.credits : null;
}
