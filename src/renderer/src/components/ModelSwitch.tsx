import { AGENT_MODEL_PRESETS, agentModelLabel } from '@shared/domain'

// Option values must be strings, so the two non-string choices get sentinels.
const KEEP = '__keep'
const CLI_DEFAULT = '__default'

interface Props {
  /** The task's current model (null = CLI default); shown as the keep-choice. */
  current: string | null
  /** undefined keeps the current model; string or null switches to that model. */
  value: string | null | undefined
  onChange: (value: string | null | undefined) => void
}

/**
 * Compact model selector shown wherever a parked run can be resumed, so the
 * user can switch to another Claude model before the run continues - the
 * escape hatch when the current model's usage credits run out mid-task.
 */
export function ModelSwitch({ current, value, onChange }: Props): React.JSX.Element {
  return (
    <select
      className="model-switch"
      aria-label="Model for the resumed run"
      title="Switch to another Claude model before the run continues, e.g. when the current model's usage limit is exhausted"
      value={value === undefined ? KEEP : (value ?? CLI_DEFAULT)}
      onChange={(e) => {
        const selected = e.target.value
        onChange(selected === KEEP ? undefined : selected === CLI_DEFAULT ? null : selected)
      }}
    >
      <option value={KEEP}>Keep {agentModelLabel(current)}</option>
      {AGENT_MODEL_PRESETS.filter((preset) => preset.id !== current).map((preset) => (
        <option key={preset.id ?? 'default'} value={preset.id ?? CLI_DEFAULT} title={preset.hint}>
          Switch to {preset.label}
        </option>
      ))}
    </select>
  )
}
