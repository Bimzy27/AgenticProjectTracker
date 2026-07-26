import { useEffect, useState } from 'react'
import type { Project, ProjectSkills, SkillEntry } from '@shared/domain'
import { tracker } from '../tracker'

export function SkillsTab({ project }: { project: Project }): React.JSX.Element {
  const [skills, setSkills] = useState<ProjectSkills | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<SkillEntry | null>(null)

  const load = (): void => {
    tracker
      .invoke('listProjectSkills', project.id)
      .then((result) => {
        setSkills(result)
        setError(null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }

  useEffect(load, [project.id])

  return (
    <div className="skills-tab">
      <div className="toolbar">
        <span className="muted">
          Skills that apply to this project, in scope order: skills installed for you personally, then skills
          checked into this repository.
        </span>
        <button className="refresh" onClick={load} title="Re-scan skill directories">
          ↻ Refresh
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {!error && skills === null && <div className="empty-state">Loading skills…</div>}
      {skills && (
        <div className="skills-tree">
          <SkillLane
            title="Global"
            hint="~/.claude/skills - applies to every project on this machine"
            entries={skills.global}
            onSelect={setViewing}
          />
          <div className="skills-tree-connector" aria-hidden="true" />
          <SkillLane
            title="Project"
            hint=".claude/skills in this repository"
            entries={skills.project}
            onSelect={setViewing}
          />
        </div>
      )}
      {viewing && <SkillSourceDialog skill={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

function SkillLane({
  title,
  hint,
  entries,
  onSelect
}: {
  title: string
  hint: string
  entries: SkillEntry[]
  onSelect: (skill: SkillEntry) => void
}): React.JSX.Element {
  return (
    <div className="skills-lane">
      <div className="skills-lane-header">
        <h3>{title}</h3>
        <p className="muted">{hint}</p>
      </div>
      {entries.length === 0 ? (
        <p className="empty-state">No skills found here.</p>
      ) : (
        <div className="skills-lane-nodes">
          {entries.map((entry) => (
            <button
              key={entry.folderName}
              className={`skill-node ${entry.shadowed ? 'shadowed' : ''}`}
              onClick={() => onSelect(entry)}
              title="View source"
            >
              <div className="skill-node-title">
                <span>{entry.name}</span>
                {entry.warning && (
                  <span className="badge attention" title={entry.warning}>
                    warning
                  </span>
                )}
                {entry.shadowed && (
                  <span
                    className="badge"
                    title="A global skill with this same name overrides it; this project skill never actually loads."
                  >
                    shadowed
                  </span>
                )}
              </div>
              {entry.description && <p className="skill-node-description">{entry.description}</p>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SkillSourceDialog({
  skill,
  onClose
}: {
  skill: SkillEntry
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>{skill.name}</h2>
        <p className="muted">{skill.folderName}/SKILL.md</p>
        <pre className="log-lines">{skill.content || '(empty file)'}</pre>
        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
