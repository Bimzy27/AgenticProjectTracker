import { useState } from 'react'
import type {
  AnalyticsWidget,
  AnalyticsWidgetInput,
  WidgetConfigField,
  WidgetKindDescriptor
} from '@shared/domain'

interface Props {
  kinds: WidgetKindDescriptor[]
  /** Existing widget to edit, or null to add a new one. */
  widget: AnalyticsWidget | null
  /** Gates sources that need the project's linked GitHub repo. */
  hasGithub: boolean
  /** Persists the widget; rejections are shown inline in the dialog. */
  onSave: (input: AnalyticsWidgetInput) => Promise<void>
  onClose: () => void
}

/**
 * Modal add/edit form for one analytics widget. The form is built generically
 * from the selected kind's config-field schema, so new widget sources get a
 * working editor without any UI changes. Secret fields are write-only: an
 * already-stored value shows as a keep-if-blank placeholder and only keys the
 * user typed into are sent back.
 */
export function WidgetDialog({ kinds, widget, hasGithub, onSave, onClose }: Props): React.JSX.Element {
  const firstUsable = kinds.find((k) => hasGithub || !k.requiresGithub) ?? kinds[0]
  const [kind, setKind] = useState<string>(widget?.kind ?? firstUsable?.kind ?? '')
  const [title, setTitle] = useState(widget?.title ?? '')
  const [config, setConfig] = useState<Record<string, string>>(widget ? { ...widget.config } : {})
  /** Only keys the user typed into; everything else keeps its stored value. */
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const descriptor = kinds.find((k) => k.kind === kind)

  const pickKind = (next: string): void => {
    setKind(next)
    setConfig({})
    setSecrets({})
    setError(null)
  }

  const save = async (): Promise<void> => {
    if (!descriptor) return
    for (const field of descriptor.configFields) {
      if (!field.required) continue
      const value =
        field.type === 'secret'
          ? (secrets[field.key] ?? (widget?.secretsSet.includes(field.key) ? 'kept' : ''))
          : config[field.key]
      if (!value?.trim()) {
        setError(`${field.label} is required.`)
        return
      }
    }
    setBusy(true)
    setError(null)
    try {
      const cleanConfig: Record<string, string> = {}
      for (const field of descriptor.configFields) {
        if (field.type === 'secret') continue
        const value = config[field.key]?.trim()
        if (value) cleanConfig[field.key] = value
      }
      await onSave({
        ...(widget ? { id: widget.id } : {}),
        kind,
        title: title.trim() === '' ? null : title.trim(),
        config: cleanConfig,
        ...(Object.keys(secrets).length > 0 ? { secrets } : {})
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{widget ? 'Edit widget' : 'Add widget'}</h2>

        {widget === null && (
          <label className="form-row">
            Source
            <select value={kind} onChange={(e) => pickKind(e.target.value)} aria-label="Widget source">
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind} disabled={k.requiresGithub && !hasGithub}>
                  {k.label}
                  {k.requiresGithub && !hasGithub ? ' (needs a linked GitHub repo)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {descriptor && <p className="muted">{descriptor.description}</p>}

        <label className="form-row">
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={descriptor?.label ?? 'Widget title'}
            aria-label="Widget title"
          />
          <span className="field-help muted">Optional; defaults to the source name.</span>
        </label>

        {descriptor?.configFields.map((field) => (
          <ConfigFieldInput
            key={`${kind}:${field.key}`}
            field={field}
            value={(field.type === 'secret' ? secrets[field.key] : config[field.key]) ?? ''}
            secretStored={widget?.secretsSet.includes(field.key) ?? false}
            onChange={(value) =>
              field.type === 'secret'
                ? setSecrets((prev) => ({ ...prev, [field.key]: value }))
                : setConfig((prev) => ({ ...prev, [field.key]: value }))
            }
          />
        ))}

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !descriptor} onClick={() => void save()}>
            {busy ? 'Saving…' : widget ? 'Save widget' : 'Add widget'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfigFieldInput({
  field,
  value,
  secretStored,
  onChange
}: {
  field: WidgetConfigField
  value: string
  /** True when a secret value is already stored for this widget. */
  secretStored: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  const placeholder =
    field.type === 'secret' && secretStored ? 'saved - leave blank to keep' : (field.placeholder ?? undefined)
  return (
    <label className="form-row">
      {field.label}
      {field.required ? '' : ' (optional)'}
      <input
        type={field.type === 'secret' ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={field.label}
      />
      {field.help && <span className="field-help muted">{field.help}</span>}
    </label>
  )
}
