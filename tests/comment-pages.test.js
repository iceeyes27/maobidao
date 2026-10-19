import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPublicComments } from '../src/archive/comment-pages.js';

test('public comments are escaped, preserve line breaks and include public replies', () => {
  const html = renderPublicComments({ complete: true, comments: [{ nickname: '<script>name</script>',
    content: 'Hello\n<img src=x onerror=alert(1)>', replies: [{ nickname: '作者', content: '回复' }] }] });
  assert.match(html, /&lt;script&gt;name/);
  assert.match(html, /Hello<br>&lt;img/);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /作者/);
});
test('missing comments stay absent and partial comments never claim completeness', () => {
  assert.equal(renderPublicComments(null), '');
  assert.match(renderPublicComments({ complete: false, comments: [] }), /部分公开留言/);
});
