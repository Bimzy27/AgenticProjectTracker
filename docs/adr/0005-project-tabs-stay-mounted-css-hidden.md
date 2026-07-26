# Project tabs stay mounted per project; switching tabs hides via CSS instead of unmounting

`ProjectView` rendered exactly one tab's component at a time (`tab === 'x' && <XTab />`), so switching tabs fully unmounted the previous one and mounted the next from scratch.
Every tab re-ran its mount-time IPC calls on every visit - Pipelines fired 5 round-trips, Analytics fired one per widget - so navigating between tabs always showed a loading flash and re-fetched data the app already had.
We decided each of a project's tabs, once visited, stays mounted for the lifetime of that `ProjectView` instance; switching tabs toggles CSS visibility (the same pattern already used for terminal panes) instead of conditionally rendering the component.
This is bounded to at most 8 mounted tabs per project, and `ProjectView` already fully remounts per project via a `key={activeProject.id}` prop, so nothing accumulates across project switches.
A future reader seeing all 8 tab components mounted at once may assume this is wasteful and "simplify" it back to conditional rendering - that would reintroduce the refetch-and-flash-on-every-switch behavior this decision exists to avoid.
