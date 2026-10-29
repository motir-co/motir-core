'use client';

import { useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import type { ProjectRepoRoleDto } from '@/lib/dto/projectRepos';
import type { SeedPromotionSourceDto, SeedRegistryEntryDto } from '@/lib/dto/seedRegistry';
import {
  HOSTING_SIZES,
  HOSTING_TARGETS,
  HOSTING_USE_CASES,
  type HostingSize,
  type HostingTarget,
  type HostingUseCase,
} from '@/lib/hosting/vocabulary';
import { PROJECT_REPO_ROLES } from '@/lib/projectRepos/vocabulary';
import { StarterAlert } from '../../_components/StarterAlert';

/**
 * The PROMOTE form — design `starter-library` §3.1–3.3, §3.5 (MOTIR-705).
 *
 * ⚠️ NOTHING IS PRE-TICKED, even when the source row names a use, size or
 * target: what a starter serves is the operator's claim, not an inference.
 * **Review promotion** stays disabled until every required field is filled and
 * at least one use and one size are ticked; it opens the confirm, and nothing is
 * copied until **Promote** there.
 *
 * Every refusal keeps the form filled. The route's typed body decides where it
 * lands: a source or manifest refusal is the alert block at the top, a field
 * refusal sits under its field (§3.3). On success the toast is raised here and
 * survives the navigation (the provider is the root layout's), and the library
 * opens with the new row tinted (`?promoted=<key>`).
 */

type Field =
  | 'source'
  | 'ref'
  | 'role'
  | 'stack'
  | 'label'
  | 'key'
  | 'useCases'
  | 'sizes'
  | 'hostingTargets'
  | 'reason';

/** The route fields a `SEED_REGISTRY_INVALID_FIELD` names, mapped to the form's. */
const ROUTE_FIELD: Record<string, Field> = {
  role: 'role',
  stack: 'stack',
  label: 'label',
  key: 'key',
  useCases: 'useCases',
  sizes: 'sizes',
  hostingTargets: 'hostingTargets',
  ref: 'ref',
};

interface RefusalBody {
  code?: string;
  refusal?: string;
  field?: string | null;
  target?: string | null;
  reason?: string | null;
  declared?: string[];
  value?: string;
  error?: string;
}

function toggle<T>(set: readonly T[], value: T, on: boolean): T[] {
  return on ? [...set.filter((v) => v !== value), value] : set.filter((v) => v !== value);
}

export function PromoteForm({ sources }: { sources: SeedPromotionSourceDto[] }) {
  const t = useTranslations('platformAdmin.starters.promoteForm');
  const ts = useTranslations('repositorySet.seed');
  const format = useFormatter();
  const router = useRouter();
  const { toast } = useToast();
  const ids = useId();

  const [sourceId, setSourceId] = useState<string | null>(null);
  const [ref, setRef] = useState('');
  const [role, setRole] = useState<ProjectRepoRoleDto | null>(null);
  const [stack, setStack] = useState('');
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [uses, setUses] = useState<HostingUseCase[]>([]);
  const [sizes, setSizes] = useState<HostingSize[]>([]);
  const [targets, setTargets] = useState<HostingTarget[]>([]);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [alert, setAlert] = useState<{ title: string; body: ReactNode; detail?: string } | null>(
    null,
  );
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});

  const source = sources.find((s) => s.id === sourceId) ?? null;
  const repoRef = source?.repoRef ?? source?.name ?? '';
  const b = (chunks: ReactNode) => <b className="font-semibold">{chunks}</b>;
  const list = (items: string[]) => format.list(items, { type: 'conjunction' });
  const targetName = (target: string) =>
    (HOSTING_TARGETS as readonly string[]).includes(target) ? ts(`target.${target}`) : target;

  const ready =
    source !== null &&
    source.unavailable === null &&
    ref.trim() !== '' &&
    role !== null &&
    stack.trim() !== '' &&
    label.trim() !== '' &&
    key.trim() !== '' &&
    uses.length > 0 &&
    sizes.length > 0 &&
    reason.trim() !== '';

  /** A field edited after a refusal drops that field's error. */
  function edited(field: Field) {
    if (fieldErrors[field]) setFieldErrors(({ [field]: _gone, ...rest }) => rest);
  }

  function stateWord(state: string, unavailable: SeedPromotionSourceDto['unavailable']) {
    if (unavailable === 'leaving') return t('source.leaving');
    if (unavailable === 'not_created') return t('source.notCreated');
    return state;
  }

  const sourceOptions: ComboboxOption<string>[] = sources.map((s) => ({
    value: s.id,
    label: s.repoRef ?? s.name,
    keywords: `${s.name} ${s.projectName}`,
    description: t('source.sub', {
      project: s.projectName,
      role: s.role,
      state: stateWord(s.state, s.unavailable),
    }),
    disabled: s.unavailable !== null,
  }));
  const roleOptions: ComboboxOption<string>[] = PROJECT_REPO_ROLES.map((r) => ({
    value: r,
    label: r,
  }));

  function refusalFor(body: RefusalBody | null): void {
    const fields: Partial<Record<Field, string>> = {};
    let next: { title: string; body: ReactNode; detail?: string } | null = null;
    const sourceTitle = t('refusal.sourceTitle');
    const manifestTitle = t('refusal.manifestTitle');
    switch (body?.code) {
      case 'SEED_PROMOTION_SOURCE_REFUSED':
        switch (body.refusal) {
          case 'taken_over':
            next = { title: sourceTitle, body: t('refusal.takenOver') };
            break;
          case 'not_created':
            next = {
              title: sourceTitle,
              body: t('refusal.notCreated', { state: source?.state ?? '' }),
            };
            break;
          case 'organization_row':
            next = { title: sourceTitle, body: t('refusal.organizationRow') };
            break;
          case 'not_motir_held':
            next = { title: sourceTitle, body: t('refusal.notMotirHeld', { repo: repoRef }) };
            break;
          default:
            next = { title: sourceTitle, body: t('refusal.notFound') };
        }
        break;
      case 'SEED_PROMOTION_REF_NOT_FOUND':
        fields.ref = t('refusal.refNotFound', { ref: ref.trim(), repo: repoRef });
        break;
      case 'SEED_PROMOTION_MANIFEST_REFUSED':
        if (body.refusal === 'missing') {
          next = {
            title: manifestTitle,
            body: t.rich('refusal.manifestMissing', { ref: ref.trim(), b }),
          };
        } else if (body.refusal === 'invalid') {
          next = {
            title: manifestTitle,
            body: t.rich('refusal.manifestInvalid', {
              ref: ref.trim(),
              field: body.field ?? t('refusal.theDocument'),
              reason: body.reason ?? '',
              b,
            }),
            detail: `motir.hosting.json · ${body.field ?? ''}`,
          };
        } else {
          const target = targetName(body.target ?? '');
          next = {
            title: manifestTitle,
            body: t.rich('refusal.targetNotDeclared', {
              target,
              declared:
                (body.declared ?? []).length > 0
                  ? list((body.declared ?? []).map(targetName))
                  : t('refusal.declaredNone'),
              b,
            }),
          };
          fields.hostingTargets = t('refusal.targetNotDeclaredField', { target, ref: ref.trim() });
        }
        break;
      case 'SEED_REGISTRY_INVALID_FIELD': {
        const field = ROUTE_FIELD[body.field ?? ''];
        const closed: Partial<Record<Field, string[]>> = {
          role: [...PROJECT_REPO_ROLES],
          useCases: HOSTING_USE_CASES.map((v) => ts(`use.${v}`)),
          sizes: HOSTING_SIZES.map((v) => ts(`size.${v}`)),
          hostingTargets: HOSTING_TARGETS.map((v) => ts(`target.${v}`)),
        };
        if (field && closed[field]) {
          fields[field] = t('refusal.notInList', {
            value: body.value ?? '',
            kind: field,
            list: format.list(closed[field] ?? [], { type: 'disjunction' }),
          });
        } else if (field) {
          fields[field] = body.error ?? t('refusal.genericBody');
        } else {
          next = { title: t('refusal.genericTitle'), body: body.error ?? t('refusal.genericBody') };
        }
        break;
      }
      case 'SEED_REGISTRY_KEY_TAKEN':
        fields.key = t('refusal.keyTaken', { key: key.trim() });
        break;
      case 'SEED_PROMOTION_TEMPLATE_NAME_TAKEN':
        fields.key = t('refusal.templateNameTaken', { key: key.trim() });
        break;
      default:
        next = { title: t('refusal.genericTitle'), body: body?.error ?? t('refusal.genericBody') };
    }
    setAlert(next);
    setFieldErrors(fields);
  }

  async function promote() {
    if (!source || !role) return;
    setPending(true);
    try {
      const res = await fetch('/api/platform/seed-registry/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceRowId: source.id,
          ref: ref.trim(),
          key: key.trim(),
          role,
          stack: stack.trim(),
          label: label.trim(),
          useCases: uses,
          sizes,
          hostingTargets: targets,
          reason: reason.trim(),
        }),
      });
      if (res.ok) {
        const entry = (await res.json()) as SeedRegistryEntryDto;
        toast({
          variant: 'success',
          title:
            entry.hostingTargets.length > 0
              ? t('done', {
                  role,
                  target: list(entry.hostingTargets.map((v) => ts(`target.${v}`))),
                  label: entry.label,
                })
              : t('doneNoTarget', { role, label: entry.label }),
        });
        router.push(`/admin/starters?promoted=${encodeURIComponent(entry.key)}`);
        return;
      }
      refusalFor((await res.json().catch(() => null)) as RefusalBody | null);
      setConfirming(false);
    } catch {
      refusalFor(null);
      setConfirming(false);
    } finally {
      setPending(false);
    }
  }

  const id = (field: Field) => `${ids}-${field}`;

  return (
    <form
      data-testid="promote-form"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) setConfirming(true);
      }}
    >
      {alert ? (
        <StarterAlert title={alert.title} testId="promote-refusal">
          <span>{alert.body}</span>
          {alert.detail ? (
            <code className="mt-1 block font-mono text-xs">{alert.detail}</code>
          ) : null}
        </StarterAlert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <Label htmlFor={id('source')}>{t('field.source')}</Label>
          <Combobox
            id={id('source')}
            label={t('field.source')}
            options={sourceOptions}
            value={sourceId}
            searchable
            placeholder={t('source.placeholder')}
            emptyText={t('source.empty')}
            triggerIcon={<ChevronDown className="size-4" aria-hidden="true" />}
            onChange={(value) => {
              setSourceId(value);
              setAlert(null);
            }}
            footer={<p className="text-xs text-(--el-text-secondary)">{t('source.footer')}</p>}
          />
          {source ? (
            <p
              data-testid="promote-source-sub"
              className="font-sans text-xs text-(--el-text-secondary)"
            >
              {t('source.sub', {
                project: source.projectName,
                role: source.role,
                state: stateWord(source.state, source.unavailable),
              })}
            </p>
          ) : null}
        </div>

        <TextField
          id={id('ref')}
          label={t('field.ref')}
          help={t('help.ref')}
          error={fieldErrors.ref}
          value={ref}
          mono
          onChange={(v) => {
            setRef(v);
            edited('ref');
          }}
        />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id('role')}>{t('field.role')}</Label>
          <Combobox
            id={id('role')}
            label={t('field.role')}
            options={roleOptions}
            value={role}
            placeholder={t('rolePlaceholder')}
            triggerIcon={<ChevronDown className="size-4" aria-hidden="true" />}
            onChange={(value) => {
              setRole(value as ProjectRepoRoleDto);
              edited('role');
            }}
          />
          <FieldError error={fieldErrors.role} />
        </div>

        <TextField
          id={id('stack')}
          label={t('field.stack')}
          help={t('help.stack')}
          error={fieldErrors.stack}
          value={stack}
          mono
          onChange={(v) => {
            setStack(v);
            edited('stack');
          }}
        />
        <TextField
          id={id('label')}
          label={t('field.label')}
          help={t('help.label')}
          error={fieldErrors.label}
          value={label}
          onChange={(v) => {
            setLabel(v);
            edited('label');
          }}
        />
        <div className="md:col-span-2">
          <TextField
            id={id('key')}
            label={t('field.key')}
            help={t('help.key')}
            error={fieldErrors.key}
            value={key}
            mono
            onChange={(v) => {
              setKey(v);
              edited('key');
            }}
          />
        </div>

        <Checks
          legend={t('field.uses')}
          required
          error={fieldErrors.useCases}
          items={HOSTING_USE_CASES.map((v) => ({ value: v, label: ts(`use.${v}`) }))}
          checked={uses}
          onChange={(value, on) => {
            setUses((current) => toggle(current, value, on));
            edited('useCases');
          }}
        />
        <Checks
          legend={t('field.sizes')}
          required
          error={fieldErrors.sizes}
          items={HOSTING_SIZES.map((v) => ({ value: v, label: ts(`size.${v}`) }))}
          checked={sizes}
          onChange={(value, on) => {
            setSizes((current) => toggle(current, value, on));
            edited('sizes');
          }}
        />
        <div className="md:col-span-2">
          <Checks
            legend={t('field.targets')}
            help={t('help.targets')}
            error={fieldErrors.hostingTargets}
            items={HOSTING_TARGETS.map((v) => ({ value: v, label: ts(`target.${v}`) }))}
            checked={targets}
            onChange={(value, on) => {
              setTargets((current) => toggle(current, value, on));
              edited('hostingTargets');
            }}
          />
        </div>

        <div className="flex flex-col gap-1.5 md:col-span-2">
          <Label htmlFor={id('reason')}>{t('field.reason')}</Label>
          <Textarea
            id={id('reason')}
            required
            rows={3}
            value={reason}
            helperText={t('help.reason')}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t border-(--el-border-soft) pt-4">
        <Link href="/admin/starters" className={buttonVariants({ variant: 'secondary' })}>
          {t('cancel')}
        </Link>
        <Button type="submit" disabled={!ready} data-testid="promote-review">
          {t('review')}
        </Button>
      </div>

      <Modal
        open={confirming}
        onOpenChange={(open) => {
          if (!pending) setConfirming(open);
        }}
        size="md"
        role="alertdialog"
        title={t('confirm.title', { name: source?.name ?? '' })}
      >
        <Modal.Body className="gap-3 text-sm text-(--el-text)">
          <p className="m-0">
            {t.rich('confirm.body', {
              repo: repoRef,
              ref: ref.trim(),
              key: key.trim(),
              label: label.trim(),
              role: role ?? '',
              b,
            })}
          </p>
          <dl
            data-testid="promote-confirm-facts"
            className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm"
          >
            <Fact term={t('confirm.roleStack')}>
              {role ?? ''} · {stack.trim()}
            </Fact>
            <Fact term={t('confirm.uses')}>{list(uses.map((v) => ts(`use.${v}`)))}</Fact>
            <Fact term={t('confirm.sizes')}>{list(sizes.map((v) => ts(`size.${v}`)))}</Fact>
            <Fact term={t('confirm.hosting')}>
              {targets.length > 0
                ? list(targets.map((v) => ts(`target.${v}`)))
                : t('confirm.notDeployed')}
            </Fact>
            <Fact term={t('confirm.reason')}>{reason.trim()}</Fact>
          </dl>
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="secondary"
            onClick={() => setConfirming(false)}
            disabled={pending}
            autoFocus
          >
            {t('confirm.back')}
          </Button>
          <Button loading={pending} onClick={promote} data-testid="promote-confirm">
            {t('confirm.promote')}
          </Button>
        </Modal.Footer>
      </Modal>
    </form>
  );
}

/** A field's label with the required mark (design § Colour and shape roles). */
function Label({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="font-sans text-sm font-medium text-(--el-text)">
      {children} <RequiredMark />
    </label>
  );
}

function RequiredMark() {
  return (
    <span aria-hidden="true" className="text-(--el-danger-on-surface)">
      *
    </span>
  );
}

function FieldError({ error }: { error?: string }) {
  return error ? (
    <p role="alert" className="font-sans text-xs text-(--el-danger-on-surface)">
      {error}
    </p>
  ) : null;
}

function TextField({
  id,
  label,
  help,
  error,
  value,
  mono,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  error?: string;
  value: string;
  mono?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        required
        value={value}
        error={error}
        helperText={help}
        className={mono ? 'font-mono' : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function Checks<T extends string>({
  legend,
  help,
  required,
  error,
  items,
  checked,
  onChange,
}: {
  legend: string;
  help?: string;
  required?: boolean;
  error?: string;
  items: { value: T; label: string }[];
  checked: readonly T[];
  onChange: (value: T, on: boolean) => void;
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1 font-sans text-sm font-medium text-(--el-text)">
        {legend} {required ? <RequiredMark /> : null}
      </legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {items.map((item) => (
          <Checkbox
            key={item.value}
            label={item.label}
            labelVisible
            checked={checked.includes(item.value)}
            onChange={(on) => onChange(item.value, on)}
          />
        ))}
      </div>
      {error ? (
        <FieldError error={error} />
      ) : help ? (
        <p className="font-sans text-xs text-(--el-text-secondary)">{help}</p>
      ) : null}
    </fieldset>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-(--el-text-secondary)">{term}</dt>
      <dd className="m-0 text-(--el-text)">{children}</dd>
    </>
  );
}
