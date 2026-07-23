import { useEffect, useState } from 'react'
import { THEME_PREFERENCES } from '@shared/domain'
import type { GithubAuthState, ThemePreference, VercelAuthState } from '@shared/domain'
import { tracker } from '../tracker'

const THEME_LABELS: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System'
}

export function SettingsView(): React.JSX.Element {
  const [auth, setAuth] = useState<GithubAuthState | null>(null)
  const [vercelAuth, setVercelAuth] = useState<VercelAuthState | null>(null)
  const [theme, setTheme] = useState<ThemePreference | null>(null)
  const [token, setToken] = useState('')
  const [vercelToken, setVercelToken] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [vercelMessage, setVercelMessage] = useState<string | null>(null)
  const [vercelError, setVercelError] = useState<string | null>(null)

  const refresh = (): void => {
    tracker.invoke('getGithubAuthState').then(setAuth).catch(console.error)
  }
  const refreshVercel = (): void => {
    tracker.invoke('getVercelAuthState').then(setVercelAuth).catch(console.error)
  }
  useEffect(refresh, [])
  useEffect(refreshVercel, [])
  useEffect(() => {
    tracker.invoke('getThemePreference').then(setTheme).catch(console.error)
  }, [])

  const chooseTheme = (pref: ThemePreference): void => {
    setTheme(pref)
    tracker.invoke('setThemePreference', pref).catch(console.error)
  }

  const act = (fn: () => Promise<string>): void => {
    setMessage(null)
    setError(null)
    fn()
      .then((msg) => {
        setMessage(msg)
        refresh()
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }

  const actVercel = (fn: () => Promise<string>): void => {
    setVercelMessage(null)
    setVercelError(null)
    fn()
      .then((msg) => {
        setVercelMessage(msg)
        refreshVercel()
      })
      .catch((err) => setVercelError(err instanceof Error ? err.message : String(err)))
  }

  return (
    <div className="settings-view">
      <header className="view-header">
        <h1>Settings</h1>
      </header>

      <section className="settings-section">
        <h2>Appearance</h2>
        <p className="muted">
          Color theme for the app. System follows the operating system's light/dark preference and switches
          automatically when it changes.
        </p>
        <div className="form-row">
          {THEME_PREFERENCES.map((pref) => (
            <label key={pref} className="toggle">
              <input
                type="radio"
                name="theme"
                disabled={theme === null}
                checked={theme === pref}
                onChange={() => chooseTheme(pref)}
              />
              {THEME_LABELS[pref]}
            </label>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h2>GitHub access</h2>
        <p className="muted">
          A Personal Access Token enables pipelines, releases, and traffic. Minimum scopes: repo (private
          repos) and read access to Actions. The token is stored encrypted in the OS credential vault, never
          in plain text. Without a token, local features (dashboard, diffs, sessions) work normally.
        </p>
        <p>
          Status:{' '}
          {auth === null ? '…' : auth.configured ? `configured (source: ${auth.source})` : 'not configured'}
        </p>
        <div className="form-row">
          <input
            type="password"
            value={token}
            placeholder="ghp_… or github_pat_…"
            onChange={(e) => setToken(e.target.value)}
          />
          <button
            className="primary"
            disabled={!token.trim()}
            onClick={() =>
              act(async () => {
                await tracker.invoke('setGithubToken', token)
                setToken('')
                return 'Token saved to the OS credential vault.'
              })
            }
          >
            Save token
          </button>
        </div>
        <div className="form-row">
          <button
            onClick={() =>
              act(async () => {
                const imported = await tracker.invoke('importGhCliToken')
                return imported
                  ? 'Imported the gh CLI token.'
                  : 'No gh CLI token found. Is gh installed and logged in?'
              })
            }
          >
            Import from gh CLI
          </button>
          {auth?.configured && (
            <button
              className="danger"
              onClick={() =>
                act(async () => {
                  await tracker.invoke('clearGithubToken')
                  return 'Token removed.'
                })
              }
            >
              Remove token
            </button>
          )}
        </div>
        {message && <p className="success-text">{message}</p>}
        {error && <p className="error-text">{error}</p>}
      </section>

      <section className="settings-section">
        <h2>Vercel access</h2>
        <p className="muted">
          An access token enables Vercel deployment pipelines: viewing recent deployments and inspecting their
          build logs on a project's Pipelines tab. Create one under Vercel account settings; for a team
          project, scope it to that team. The token is stored encrypted in the OS credential vault, never in
          plain text. Link a project to a Vercel project on its own view to start polling it.
        </p>
        <p>Status: {vercelAuth === null ? '…' : vercelAuth.configured ? 'configured' : 'not configured'}</p>
        <div className="form-row">
          <input
            type="password"
            value={vercelToken}
            placeholder="Vercel access token"
            onChange={(e) => setVercelToken(e.target.value)}
          />
          <button
            className="primary"
            disabled={!vercelToken.trim()}
            onClick={() =>
              actVercel(async () => {
                await tracker.invoke('setVercelToken', vercelToken)
                setVercelToken('')
                return 'Token saved to the OS credential vault.'
              })
            }
          >
            Save token
          </button>
        </div>
        {vercelAuth?.configured && (
          <div className="form-row">
            <button
              className="danger"
              onClick={() =>
                actVercel(async () => {
                  await tracker.invoke('clearVercelToken')
                  return 'Token removed.'
                })
              }
            >
              Remove token
            </button>
          </div>
        )}
        {vercelMessage && <p className="success-text">{vercelMessage}</p>}
        {vercelError && <p className="error-text">{vercelError}</p>}
      </section>

      <section className="settings-section">
        <h2>Claude CLI</h2>
        <p className="muted">
          Agent sessions require the Claude CLI (`claude`) to be installed and logged in. Sessions started in
          a terminal are discovered automatically from Claude's session storage; sessions started here are
          fully controllable, including permission modes.
        </p>
      </section>
    </div>
  )
}
