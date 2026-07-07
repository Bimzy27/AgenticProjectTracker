import { useEffect, useState } from 'react'
import type { GithubAuthState } from '@shared/domain'
import { tracker } from '../tracker'

export function SettingsView(): React.JSX.Element {
  const [auth, setAuth] = useState<GithubAuthState | null>(null)
  const [token, setToken] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = (): void => {
    tracker.invoke('getGithubAuthState').then(setAuth).catch(console.error)
  }
  useEffect(refresh, [])

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

  return (
    <div className="settings-view">
      <header className="view-header">
        <h1>Settings</h1>
      </header>

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
