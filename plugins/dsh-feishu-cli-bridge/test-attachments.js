import assert from 'node:assert/strict';
import { attachmentPrompt, normalizeInboundAttachment } from './bridge/engine.js';

assert.deepEqual(normalizeInboundAttachment('image', { image_key: 'img_v3' }), {
  kind: '图片', resourceType: 'image', key: 'img_v3',
});
assert.deepEqual(normalizeInboundAttachment('media', { file_key: 'file_v3' }), {
  kind: '视频', resourceType: 'file', key: 'file_v3',
});
assert.deepEqual(normalizeInboundAttachment('audio', { file_key: 'file_audio' }), {
  kind: '音频', resourceType: 'file', key: 'file_audio',
});
assert.deepEqual(normalizeInboundAttachment('file', { file_key: 'file_doc' }), {
  kind: '文件', resourceType: 'file', key: 'file_doc',
});
assert.equal(normalizeInboundAttachment('media', {}), null);
assert.equal(attachmentPrompt('视频', 'clip.mp4', '/srv/media'), '[用户发来视频，已下载到 /srv/media/clip.mp4 供你使用]');
assert.equal(attachmentPrompt('图片', '/tmp/image.png', '/srv/media'), '[用户发来图片，已下载到 /tmp/image.png 供你使用]');
console.log('ATTACHMENTS-OK');
