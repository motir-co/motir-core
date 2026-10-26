'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { HostedRunCancel } from '@/app/(authed)/runs/_components/HostedRunCancel';
import { isLiveRun } from '@/lib/runs/timeline';
import { HostedModelPicker } from './HostedModelPicker';
import { HostedHeldLine, HostedModelProvenance } from '@/components/hosted/HostedModelPicker';
import { allHeld, isHeld, provenanceFor } from '@/components/hosted/hostedModels';
import { useHostedRun } from './HostedRunProvider';

// THE RUN SECTION'S HEADER DOOR (Story MOTIR-683 · MOTIR-691; revised by
// MOTIR-7022 revision 2 · MOTIR-7028, `design/runs/design-notes.md` § Revision 2).
//
// Revision 2 moved the ways to START out of the header and into the start bar at
// the top of the section's body (`StartBar`), so the header holds at most one
// control, and only while a run is live on the work item:
//
//   · a run Motir works (`hosted`) is live → Cancel run;
//   · a run in an agent (`instance`) is live → Cancel run for the agent's OWNER
//     only (`agent-instance-run.md` §6: only the owner reaches an agent);
//   · a LOCAL run is live, or nothing is → nothing.

export function RunHostedButton() {
  const t = useTranslations('runs.agent.cancel');
  const door = useHostedRun();
  if (!door) return null;
  const run = door.currentRun;
  if (!run || !isLiveRun(run.status)) return null;
  if (run.origin === 'hosted') {
    return <HostedRunCancel runId={run.id} onCancelled={door.notifyRunsChanged} />;
  }
  if (run.origin === 'instance' && door.viewerId !== null && run.createdById === door.viewerId) {
    return (
      <HostedRunCancel
        runId={run.id}
        onCancelled={door.notifyRunsChanged}
        body={t('body', { name: run.agentName ?? '' })}
      />
    );
  }
  return null;
}

/**
 * RUN — the start bar's first option's control: the model picker and **Run**
 * (**Run again** once a run in Motir's cloud has ended). Disabled, never hidden,
 * on a card that is not ready — its reason is one line under the bar.
 *
 * ⚠️ THE SOURCE LINE (MOTIR-6996; design § Run hosted — the picker says where its
 * model came from). While the picker holds the card's RESOLVED model, the row's
 * last child says why — its difficulty, a project override, or a parent's
 * leaves. It goes when the person picks another model (F6), and comes back if
 * they re-pick it. `items-start` keeps the button level with the trigger.
 *
 * ⚠️ A HELD MODEL HOLDS RUN (MOTIR-9630; design § The preselect decision). When the
 * selected model has no agent-run capacity the selection STAYS, Run is off, and
 * the *Held Run line* follows the source line — except while the No-capacity
 * refusal stands (it names the model) or every model is held (the notices' line
 * says it once).
 */
export function RunDoorControl() {
  const t = useTranslations('runs.hosted.door');
  const door = useHostedRun();
  const lineId = useId();
  const heldId = useId();
  if (!door) return null;
  const run = door.currentRun;
  const modelsReady = door.models.state === 'ok' && door.models.models.length > 0;
  const sending = door.agentDoor?.sendingId != null;
  const held = isHeld(door.models, door.selectedModel);
  const disabled =
    !door.ready || !modelsReady || door.starting || sending || !door.selectedModel || held;
  const heldLine =
    held && door.refusal?.kind !== 'noCapacity' && !allHeld(door.models)
      ? door.selectedModel
      : null;
  // "Run again" after a run in Motir's cloud — Motir's own, or one in an agent —
  // never after a local one.
  const again = run?.origin === 'hosted' || run?.origin === 'instance';
  const provenance = provenanceFor(door.models, door.selectedModel);

  return (
    <div className="flex min-w-0 flex-wrap items-start gap-2" data-testid="run-hosted-door">
      <HostedModelPicker
        models={door.models}
        value={door.selectedModel}
        onChange={door.selectModel}
        disabled={!door.ready || door.starting}
        provenance={provenance}
        describedBy={lineId}
      />
      <Button
        type="button"
        variant="primary"
        size="sm"
        disabled={disabled}
        loading={door.starting}
        onClick={() => void door.start()}
        aria-describedby={heldLine ? heldId : undefined}
        data-testid="run-hosted"
        // The anchor the design card's "Automatic re-run skipped" lines link to (MOTIR-702).
        id="run-hosted"
      >
        {door.starting ? t('starting') : again ? t('runAgain') : t('run')}
      </Button>
      <HostedModelProvenance provenance={provenance} id={lineId} />
      <HostedHeldLine model={heldLine} id={heldId} />
    </div>
  );
}
