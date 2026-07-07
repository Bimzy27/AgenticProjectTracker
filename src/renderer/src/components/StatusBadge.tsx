import type { RunStatus } from '@shared/domain'

const LABELS: Record<RunStatus, string> = {
  success: 'passing',
  failure: 'failing',
  in_progress: 'running',
  queued: 'queued',
  cancelled: 'cancelled',
  action_required: 'needs action',
  neutral: 'neutral',
  unknown: 'unknown'
}

export function StatusBadge({ status }: { status: RunStatus }): React.JSX.Element {
  return <span className={`badge status-${status}`}>{LABELS[status]}</span>
}
