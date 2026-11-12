import type { WorkflowDto } from '@/lib/dto/workflows';

/**
 * The shortest walk from `fromStatusKey` to Done along the workflow's declared
 * edges — the statuses to move through, in order, ending at Done (`prompts/mark.md`'s
 * walk, A2.6). The target is the `done` status when the project has one in the done
 * category, else the first done-category status that is not `cancelled`. An `open`
 * policy moves straight there. `[]` when the card is already at Done; `null` when
 * no target or no path exists.
 *
 * ⚠️ PURE, over a workflow the caller already read, so a caller that moves a card
 * by the system's own authority (an init card completing on its repository being
 * established, MOTIR-11054) and the guided walk (`guideLandingService`) take the
 * same road. A move straight from `todo` to `done` is illegal under the default
 * workflow, which is why neither may simply jump there.
 */
export function walkToDone(wf: WorkflowDto, fromStatusKey: string): string[] | null {
  const done = wf.statuses.filter((s) => s.category === 'done');
  const target =
    done.find((s) => s.key === 'done') ?? done.find((s) => s.key !== 'cancelled') ?? null;
  if (!target) return null;
  if (fromStatusKey === target.key) return [];
  if (wf.policyMode === 'open') return [target.key];
  const byId = new Map(wf.statuses.map((s) => [s.id, s]));
  const from = wf.statuses.find((s) => s.key === fromStatusKey);
  if (!from) return null;
  const prev = new Map<string, string>([[from.id, '']]);
  const queue = [from.id];
  while (queue.length > 0) {
    const at = queue.shift()!;
    if (at === target.id) break;
    for (const t of wf.transitions) {
      if (t.fromStatusId !== at || prev.has(t.toStatusId)) continue;
      const to = byId.get(t.toStatusId);
      // Never walk THROUGH another terminal status (a cancel is not a road to Done).
      if (!to || (to.category === 'done' && to.id !== target.id)) continue;
      prev.set(t.toStatusId, at);
      queue.push(t.toStatusId);
    }
  }
  if (!prev.has(target.id)) return null;
  const path: string[] = [];
  for (let id = target.id; id !== from.id; id = prev.get(id)!) path.unshift(byId.get(id)!.key);
  return path;
}
