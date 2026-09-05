// dsh-image-vision as a cordis plugin: registers the view_image agent tool.
// Load either as a bundle (dsh.profile.bundles: ["dsh-image-vision"])
// or by insert (name: 'dsh-image-vision' or 'dsh-image-vision/tools').
export { name, inject, apply } from './tools/index.js';