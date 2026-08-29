// dsh-github-toolkit as a cordis plugin: registers the gh_* agent tools.
// Load either as a bundle (dsh.profile.bundles: ["dsh-github-toolkit"])
// or by insert (name: 'dsh-github-toolkit' or 'dsh-github-toolkit/tools').
export { name, inject, apply } from './tools/index.js';
