import type {
  AnalyticsWidget,
  AnalyticsWidgetInput,
  Project,
  WidgetData,
  WidgetKindDescriptor
} from '@shared/domain'
import type { DashboardStore } from './DashboardStore'
import { GithubNotConfiguredError } from './GithubClient'

/** Everything a provider gets to resolve one widget's data. */
export interface WidgetFetchContext {
  project: Project
  /** Non-secret config merged with the widget's decrypted secret values. */
  config: Record<string, string>
}

/**
 * A pluggable analytics source (D7): describes itself so the UI can offer and
 * configure it generically, and fetches data for one widget instance.
 * Expected gaps (no repo access, endpoint says forbidden) are reported in-band
 * as the 'unavailable' shape; unexpected failures reject.
 */
export interface WidgetProvider {
  readonly descriptor: WidgetKindDescriptor
  fetch(ctx: WidgetFetchContext): Promise<WidgetData>
}

/**
 * Ids of the default dashboard widgets, shown until the user customizes the
 * layout. Stable so getWidgetData can resolve them without persisting anything,
 * and so a first customization round-trips them unchanged.
 */
const DEFAULT_GITHUB_WIDGETS: AnalyticsWidget[] = [
  { id: 'default-github-views', kind: 'github-traffic-views', title: null, config: {}, secretsSet: [] },
  { id: 'default-github-clones', kind: 'github-traffic-clones', title: null, config: {}, secretsSet: [] },
  { id: 'default-github-releases', kind: 'github-releases', title: null, config: {}, secretsSet: [] }
]

/**
 * Hosts the widget-provider registry and each project's dashboard layout.
 * The UI talks only in WidgetKindDescriptor / AnalyticsWidget / WidgetData
 * terms, so new sources plug in here without renderer changes.
 */
export class AnalyticsService {
  private readonly providers = new Map<string, WidgetProvider>()

  constructor(
    providers: WidgetProvider[],
    private readonly store: DashboardStore
  ) {
    for (const provider of providers) {
      const kind = provider.descriptor.kind
      if (this.providers.has(kind)) throw new Error(`Duplicate widget provider kind: ${kind}`)
      this.providers.set(kind, provider)
    }
  }

  /** All registered widget kinds, in registration order. */
  listKinds(): WidgetKindDescriptor[] {
    return [...this.providers.values()].map((p) => p.descriptor)
  }

  /**
   * The project's effective dashboard: the stored layout, or the default
   * GitHub widgets when never customized (empty without a linked repo).
   */
  getWidgets(project: Project): AnalyticsWidget[] {
    const stored = this.store.getWidgets(project.id)
    if (stored) return stored
    return project.github ? DEFAULT_GITHUB_WIDGETS : []
  }

  /**
   * Replace the project's dashboard. Validates every widget against its kind's
   * descriptor (known kind, required config present - a required secret may
   * also be satisfied by a value already stored for that widget id).
   */
  setWidgets(project: Project, inputs: AnalyticsWidgetInput[]): AnalyticsWidget[] {
    const current = new Map(this.getWidgets(project).map((w) => [w.id, w]))
    for (const input of inputs) {
      const provider = this.providers.get(input.kind)
      if (!provider) throw new Error(`Unknown widget kind: ${input.kind}`)
      for (const field of provider.descriptor.configFields) {
        if (!field.required) continue
        if (field.type === 'secret') {
          const provided = input.secrets?.[field.key]
          const alreadyStored =
            provided === undefined &&
            input.id !== undefined &&
            (current.get(input.id)?.secretsSet.includes(field.key) ?? false)
          if (!provided && !alreadyStored) {
            throw new Error(`Widget "${provider.descriptor.label}" needs a value for ${field.label}`)
          }
        } else if (!input.config[field.key]?.trim()) {
          throw new Error(`Widget "${provider.descriptor.label}" needs a value for ${field.label}`)
        }
      }
    }
    return this.store.setWidgets(project.id, inputs)
  }

  /**
   * Resolve one widget's data via its provider. Missing GitHub prerequisites
   * (no linked repo, no token) and unknown kinds (e.g. a stored widget whose
   * source was removed) come back in-band as 'unavailable'; provider errors
   * beyond that reject and surface on the widget card.
   */
  async getWidgetData(project: Project, widgetId: string): Promise<WidgetData> {
    const widget = this.getWidgets(project).find((w) => w.id === widgetId)
    if (!widget) throw new Error(`No widget ${widgetId} on this project's dashboard`)
    const provider = this.providers.get(widget.kind)
    if (!provider) {
      return { shape: 'unavailable', reason: `The widget source "${widget.kind}" is not installed.` }
    }
    if (provider.descriptor.requiresGithub && !project.github) {
      return { shape: 'unavailable', reason: 'Link a GitHub repo to this project to use this widget.' }
    }
    const config = { ...widget.config, ...this.store.getSecrets(project.id, widgetId) }
    try {
      return await provider.fetch({ project, config })
    } catch (err) {
      if (err instanceof GithubNotConfiguredError) {
        return {
          shape: 'unavailable',
          reason: 'This widget needs a GitHub token. Configure one in Settings.'
        }
      }
      throw err
    }
  }

  /** Drop a removed project's dashboard (see DashboardStore.deleteProject). */
  removeProject(projectId: string): void {
    this.store.deleteProject(projectId)
  }
}
