import {
  PIPELINE_VIEWS, pipelineHref, type PipelineQuery, type PipelineView,
} from '@/components/pipeline/view';
import { SegmentedLinks } from '@/components/ui/SegmentedLinks';

/**
 * Board or list, as a `SegmentedLinks` sitting IN the count line.
 *
 * The argument for the control itself -- why it is not its own row, why not a
 * dropdown, why every segment is a real link -- is `SegmentedLinks`'s own
 * docblock now, since it is the same argument regardless of which two views
 * are being chosen between. What is specific to this screen is only the
 * wording and the two views, which is all that is left here.
 */
export function ViewToggle({
  basePath,
  filters,
  view,
}: {
  basePath: string;
  /** The filters in force, carried through the swap unchanged. */
  filters: PipelineQuery;
  view: PipelineView;
}) {
  return (
    <SegmentedLinks
      ariaLabel="How the pipeline is drawn"
      options={PIPELINE_VIEWS.map((entry) => ({
        href: pipelineHref(basePath, filters, entry.view),
        label: entry.label,
        active: entry.view === view,
      }))}
    />
  );
}
