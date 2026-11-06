import { Card } from '@/components/ui/Card';

/**
 * The findings list's loading frame — design MOTIR-10362 Panel 4, the
 * `PlatformLessonsSkeleton` shape. The page header is static copy already
 * painted above this frame; the card head paints at once, a row of filter
 * blocks and five table rows wait. One status announcement for the region; the
 * blocks are decorative.
 */
export function FindingsSkeleton({ title, label }: { title: string; label: string }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" data-testid="planner-findings-loading">
      <Card header={<h2 className="font-sans text-sm font-semibold text-(--el-text)">{title}</h2>}>
        <div className="flex animate-pulse flex-col gap-4" aria-hidden="true">
          <div className="flex flex-wrap gap-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Block key={i} className="h-(--height-control) w-36" />
            ))}
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <Block className="h-4 w-56" />
              <Block className="h-4 w-24" />
              <Block className="h-4 w-24" />
              <Block className="h-4 w-40" />
              <Block className="h-3 w-24" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Block({ className }: { className: string }) {
  return <div className={`rounded-(--radius-control) bg-(--el-muted) ${className}`} />;
}
