import { escapeHtml } from './pages.js';

export function renderPublicComments(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.comments)) return '';
  const entry = (comment, reply = false) => `<${reply ? 'blockquote' : 'section'}><p><strong>${escapeHtml(comment.nickname || '微信用户')}</strong></p><p>${escapeHtml(comment.content).replaceAll('\n', '<br>')}</p>${reply ? '' : (comment.replies || []).map(value => entry(value, true)).join('')}</${reply ? 'blockquote' : 'section'}>`;
  return `<section class="archived-comments" aria-label="微信公开留言"><h2>微信公开留言</h2><p>${snapshot.complete ? '已保存本次可读取的公开留言及回复。' : '已保存部分公开留言，后续验证可继续补充。'}</p>${snapshot.comments.map(value => entry(value)).join('')}</section>`;
}
