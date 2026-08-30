// dsh-maintain: registers three agent tools over the existing maintenance
// loop so the agent can see/trigger it from the web UI instead of shelling
// out manually. Zero dsh-internal imports: only Node builtins, so the plugin
// can be symlinked into a profile without resolution concerns.
export { name, inject, apply } from './tools/index.js';