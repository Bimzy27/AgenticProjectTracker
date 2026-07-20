import { useCallback, useEffect, useState } from 'react'
import type { AnalyticsWidget, AnalyticsWidgetInput, Project, WidgetKindDescriptor } from '@shared/domain'
import { InfoTip } from '../components/InfoTip'
import { WidgetBody } from '../components/WidgetBody'
import type { WidgetResult } from '../components/WidgetBody'
import { WidgetDialog } from '../components/WidgetDialog'
import { tracker } from '../tracker'

/**
 * The project's analytics dashboard: a per-project, user-customizable list of
 * pluggable widgets. Each widget loads independently, so one broken source
 * shows its error on its own card instead of taking down the whole view.
 */
export function AnalyticsTab({ project }: { project: Project }): React.JSX.Element {
  const [kinds, setKinds] = useState<WidgetKindDescriptor[] | null>(null)
  const [widgets, setWidgets] = useState<AnalyticsWidget[] | null>(null)
  const [results, setResults] = useState<Record<string, WidgetResult>>({})
  /** null: closed; { widget: null }: add; { widget }: edit. */
  const [dialog, setDialog] = useState<{ widget: AnalyticsWidget | null } | null>(null)
  const [layoutError, setLayoutError] = useState<string | null>(null)

  const fetchData = useCallback(
    (widgetId: string): void => {
      setResults((prev) => ({ ...prev, [widgetId]: 'loading' }))
      tracker
        .invoke('getWidgetData', project.id, widgetId)
        .then((data) => setResults((prev) => ({ ...prev, [widgetId]: { data } })))
        .catch((err) =>
          setResults((prev) => ({
            ...prev,
            [widgetId]: { error: err instanceof Error ? err.message : String(err) }
          }))
        )
    },
    [project.id]
  )

  // The tab is keyed by project id in ProjectView, so a project switch
  // remounts with fresh state and this effect only ever loads.
  useEffect(() => {
    tracker.invoke('listWidgetKinds').then(setKinds).catch(console.error)
    tracker
      .invoke('getAnalyticsWidgets', project.id)
      .then((list) => {
        setWidgets(list)
        for (const widget of list) fetchData(widget.id)
      })
      .catch((err) => setLayoutError(err instanceof Error ? err.message : String(err)))
  }, [project.id, fetchData])

  /** Persist a full layout; refetches data only where `refetch` says so. */
  const saveLayout = async (
    inputs: AnalyticsWidgetInput[],
    refetch: (savedId: string) => boolean
  ): Promise<void> => {
    const saved = await tracker.invoke('setAnalyticsWidgets', project.id, inputs)
    setWidgets(saved)
    for (const widget of saved) {
      if (refetch(widget.id) || results[widget.id] === undefined) fetchData(widget.id)
    }
  }

  const upsertWidget = async (input: AnalyticsWidgetInput): Promise<void> => {
    const current = widgets ?? []
    const editing = input.id !== undefined && current.some((w) => w.id === input.id)
    const inputs = editing
      ? current.map((w) => (w.id === input.id ? input : toInput(w)))
      : [...current.map(toInput), input]
    // Refetch the edited widget; a new widget's id is unknown until saved and
    // is covered by the "no result yet" refetch in saveLayout.
    await saveLayout(inputs, (id) => id === input.id)
  }

  const removeWidget = (widgetId: string): void => {
    const inputs = (widgets ?? []).filter((w) => w.id !== widgetId).map(toInput)
    saveLayout(inputs, () => false).catch((err) => setLayoutError(String(err)))
  }

  const moveWidget = (index: number, delta: -1 | 1): void => {
    const list = [...(widgets ?? [])]
    const target = index + delta
    if (target < 0 || target >= list.length) return
    ;[list[index], list[target]] = [list[target], list[index]]
    saveLayout(list.map(toInput), () => false).catch((err) => setLayoutError(String(err)))
  }

  if (layoutError) return <div className="error-text">{layoutError}</div>
  if (widgets === null || kinds === null) {
    return <div className="empty-state">Loading dashboard…</div>
  }

  return (
    <div className="analytics-tab">
      <div className="widget-toolbar">
        <span className="muted">
          Your dashboard for this project - add widgets from any supported source.
        </span>
        <button onClick={() => setDialog({ widget: null })}>+ Add widget</button>
      </div>

      {widgets.length === 0 ? (
        <div className="empty-state">
          No widgets yet. Add one above
          {project.github ? '' : ', or link a GitHub repo to get the default GitHub dashboard'}.
        </div>
      ) : (
        <div className="widget-grid">
          {widgets.map((widget, index) => (
            <WidgetCard
              key={widget.id}
              widget={widget}
              descriptor={kinds.find((k) => k.kind === widget.kind) ?? null}
              result={results[widget.id] ?? 'loading'}
              isFirst={index === 0}
              isLast={index === widgets.length - 1}
              onMoveUp={() => moveWidget(index, -1)}
              onMoveDown={() => moveWidget(index, 1)}
              onEdit={() => setDialog({ widget })}
              onRemove={() => removeWidget(widget.id)}
            />
          ))}
        </div>
      )}

      {dialog && (
        <WidgetDialog
          kinds={kinds}
          widget={dialog.widget}
          hasGithub={project.github !== null}
          onSave={upsertWidget}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}

function WidgetCard({
  widget,
  descriptor,
  result,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onEdit,
  onRemove
}: {
  widget: AnalyticsWidget
  /** null when the widget's source is no longer installed. */
  descriptor: WidgetKindDescriptor | null
  result: WidgetResult
  isFirst: boolean
  isLast: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onEdit: () => void
  onRemove: () => void
}): React.JSX.Element {
  const title = widget.title ?? descriptor?.label ?? widget.kind
  // Release lists want the full row; charts and stats share it.
  const wide = result !== 'loading' && 'data' in result && result.data.shape === 'releases'
  return (
    <section className={`widget-card ${wide ? 'widget-wide' : ''}`}>
      <header className="widget-header">
        <h2>
          {title}
          {descriptor && <InfoTip text={descriptor.description} />}
        </h2>
        <div className="widget-actions">
          <button
            aria-label={`Move ${title} widget up`}
            title="Move up"
            disabled={isFirst}
            onClick={onMoveUp}
          >
            ↑
          </button>
          <button
            aria-label={`Move ${title} widget down`}
            title="Move down"
            disabled={isLast}
            onClick={onMoveDown}
          >
            ↓
          </button>
          <button aria-label={`Edit ${title} widget`} title="Edit widget" onClick={onEdit}>
            ✎
          </button>
          <button aria-label={`Remove ${title} widget`} title="Remove widget" onClick={onRemove}>
            ✕
          </button>
        </div>
      </header>
      <WidgetBody result={result} />
    </section>
  )
}

function toInput(widget: AnalyticsWidget): AnalyticsWidgetInput {
  return { id: widget.id, kind: widget.kind, title: widget.title, config: widget.config }
}
